# SPECS.md — especificação do agente Greenlight

> **Versão:** 1.0.0 · **Status:** implementado e coberto por testes · **Atualizado:** 2026-10-22
>
> Este documento é normativo: descreve os contratos que o código cumpre hoje. Se o código divergir
> daqui, um dos dois está errado — e o commit que muda o contrato precisa atualizar este arquivo.

---

## 0. Escopo

### O que o agente é

Um revisor de pull request que recebe **um diff unificado** e devolve um **laudo estruturado**:
achados com severidade e localização, sugestões de correção aplicáveis, sugestões de teste, quatro
checagens e um veredito de merge.

### O que ele não é

- Não é linter de estilo completo (indentação, aspas, ordem de imports) — isso é trabalho do ESLint/Ruff.
- Não é type checker, não compila, não roda testes do projeto (até M3, e mesmo lá só se pedido).
- Não faz merge, não aprova PR, não substitui revisor humano.
- Não envia código para fora da máquina sem autorização explícita (LLM é opt-in por chave de ambiente).

### Superfícies

| Superfície | Entrada | Saída |
| --- | --- | --- |
| CLI `gl` | arquivo, stdin ou `--pr dono/repo#n` | texto, Markdown ou JSON + código de saída |
| HTTP/SSE | `POST /api/review` | JSON ou eventos |
| GitHub App | webhook `pull_request` | review inline + check run |
| Painel da landing | mesma API HTTP | painel interativo em `#agent` |

Todas as quatro usam **o mesmo motor** (`agent/review.js`). Não existe caminho alternativo.

---

## 1. Arquitetura

```
                 ┌────────────────────────────────────────────────┐
   diff ────────▶│ agent/diff.js · parseDiff()                    │
                 │ arquivos → hunks → linhas (type/old/new)       │
                 └───────────────┬────────────────────────────────┘
                                 ▼
   .greenlight.json ──▶ agent/config.js · normalizeConfig()
   .greenlight/*.json ─▶ agent/context.js · aprendizado
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │ agent/review.js · pipeline                     │
                 │  regras de linha → regras de diff → LLM        │
                 │  → dedupe → supressão → score                  │
                 └───────┬──────────────┬──────────────┬──────────┘
                         ▼              ▼              ▼
                 agent/report.js   server/index.js   agent/github.js
                   (texto/JSON)     (HTTP + SSE)      (comentário/check)
```

### Responsabilidades por módulo

| Módulo | Responsabilidade | Não faz |
| --- | --- | --- |
| `diff.js` | parse do diff, detecção de linguagem/teste/binário | decisão de ignorar por config |
| `glob.js` | casamento de padrões `**/*.js` sem dependências | regex de caminho ad hoc |
| `config.js` | defaults, merge, validação, exceções | ler ambiente de LLM (isso é `llm.js`) |
| `learn.js` | índice do repo, convenções, regras da casa | análise do diff |
| `review.js` | orquestração, supressão, dedupe, eventos | formatação de saída |
| `findings.js` | normalização, fingerprint, contagem | decidir severidade (vem da regra) |
| `scoring.js` | checagens, veredito, resumo | rodar regra |
| `suggestions.js` | montar `Suggestion` consistente | aplicar no diff |
| `patch.js` | aplicar `replace` em um arquivo do diff | validar sintaxe |
| `llm.js` | provedor, redação, validação da saída | bloquear merge |
| `github.js` | API REST do GitHub | receber webhook |
| `server/*` | HTTP, estáticos, SSE, webhook | regra de negócio |
| `bin/greenlight.js` | CLI, exit codes | motor |

---

## 2. Pipeline

`reviewPipeline(diffText, options)` é um **gerador assíncrono** que emite eventos reais conforme cada
etapa termina. A ordem é fixa:

| # | `stage.id` | `label` (pt-BR) | Emite |
| --- | --- | --- | --- |
| 1 | `parse` | Lendo o diff | `stage` |
| 2 | `context` | Carregando contexto | `stage` |
| 3 | `lint` | Lint e regras da casa | `stage` |
| 4 | `security` | Segurança | `stage` |
| 5 | `bugs` | Bugs e lógica | `stage` |
| 6 | `tests` | Testes e cobertura | `stage` |
| 7 | `llm` | Revisão semântica (LLM) | só com LLM ligado e `additions > 0`; `done` ou `warn` |
| 8 | `score` | Calculando o veredito | `stage` |
| — | — | — | `checks`, `findings`, `summary`, `done` |

Cada `stage` traz `{ type:'stage', id, label, status: 'running'|'done'|'warn'|'fail', detail, ms }`.
`ms` é a duração **medida** daquela etapa (nunca valor de fábrica). O painel usa exatamente esse
número; o README não deve citar outro.

`options` aceitos por `review()` / `reviewPipeline()`:

| Opção | Tipo | Efeito |
| --- | --- | --- |
| `root` | string | raiz para ler `.greenlight.json` e o índice |
| `env` | object | ambiente injetável (testes) |
| `config` | object | config já normalizada (sobrepõe arquivo) |
| `index` | object\|null | índice aprendido; `null` = não usar |
| `memory` | object | dispensas da sessão |
| `llm` | `false`\|undefined | `false` desliga LLM nesta revisão |
| `failOn` | string | sobrepõe `failOn` da config |
| `source` | string | `cli`, `web`, `demo:<id>`, `github` |
| `defaultPath` | string | caminho quando o diff não traz cabeçalho |
| `logger` | function | recebe uma linha de log ao final |

---

## 3. Contratos de dados

### 3.1 Diff

`parseDiff(text, { defaultPath })` devolve:

```jsonc
{
  "files": [{
    "path": "api/webhooks.ts",        // caminho novo (ou antigo, se removido)
    "previousPath": null,             // preenchido em rename
    "status": "modified",             // added | modified | removed | renamed
    "language": "ts",                 // derivado da extensão; "text" se desconhecida
    "isTest": true,                   // padrão de caminho de teste
    "binary": false,
    "additions": 12,
    "deletions": 3,
    "hunks": [{
      "header": "@@ -10,7 +10,9 @@",
      "oldStart": 10, "newStart": 10,
      "lines": [{ "type": "add", "content": "...", "oldLine": null, "newLine": 11 }]
    }]
  }],
  "stats": { "files": 2, "additions": 17, "deletions": 1, "hunks": 2, "binary": 0,
             "analyzedFiles": 2, "ignoredFiles": 0 }
}
```

Invariantes:

- `line.type ∈ {'add','del','context'}`; `newLine` só existe em `add`/`context`.
- Arquivo sem hunk e sem marca binária é descartado do resultado.
- O parser **nunca lança** por conteúdo estranho: devolve o que conseguiu interpretar.
- `stats.ignoredFiles` conta arquivos removidos por `ignore`/config, não por falta de hunk.

### 3.2 Finding

```jsonc
{
  "id": "1e472ebb7ee380ce",          // 16 hex, sha256(ruleId, file, line, title, code)
  "ruleId": "BUG001",
  "title": "Retry sem backoff",
  "severity": "medium",               // critical | high | medium | low | info
  "category": "bug",                  // security | bug | quality | tests | house
  "check": "bugs",                    // lint | bugs | tests | security
  "file": "api/webhooks.ts",
  "line": 11,
  "endLine": 11,
  "message": "Retry com espera fixa entre tentativas — sem backoff exponencial.",
  "why": "Sob falha contínua, retentar no mesmo ritmo martela o serviço…",
  "code": "for (let i = 0; i < attempts; i++) {",
  "confidence": 0.9,
  "source": "rule",                   // rule | llm
  "suggestion": { /* §3.3 */ },
  "docs": ""
}
```

Regras de normalização (`createFinding`):

- `severity` inválida → `medium`; `category` inválida → `quality`.
- `code` truncado em 400 caracteres; `file` ausente → `"diff"`; `line` não inteiro → `null`.
- `endLine` default = `line`; `check` derivado da categoria quando omitido.
- **O `id` é estável**: mesma regra + arquivo + linha + título + trecho ⇒ mesmo id, o que faz a
  dispensa sobreviver a novas execuções.

### 3.3 Suggestion

```jsonc
{
  "title": "Adicionar backoff exponencial com jitter",
  "language": "typescript",           // rótulo para highlight; não altera o motor
  "code": "  for (let i = 0; …",
  "mode": "replace",                  // info | replace | test
  "applyable": true,                  // só true em mode=replace com startLine/endLine
  "startLine": 11,
  "endLine": 17,
  "filename": "api/webhooks.ts"       // opcional, para esqueleto de teste
}
```

- `mode:'info'` → texto explicativo, nunca aplicável (o servidor recusa).
- `mode:'replace'` → substitui `[startLine, endLine]` no arquivo, preservando indentação relativa.
- `mode:'test'` → esqueleto de teste no framework detectado; cria novo arquivo quando aplicado
  fora do diff (não aplicável pelo painel).

### 3.4 Check

```jsonc
{
  "id": "security", "label": "Segurança",
  "status": "fail",                   // pass | warn | fail | skip
  "summary": "3 bloqueios",
  "findings": 5, "blocking": 3,
  "counts": { "critical": 1, "high": 2, "medium": 1, "low": 1, "info": 0 }
}
```

`status` é derivado (SPECS §7): `fail` se há achado ≥ `failOn`; senão `warn` se há achado ≥ `warnAt`
da checagem; senão `pass`. `skip` quando `config.checks[id] === false`.

### 3.5 Verdict

```jsonc
{
  "status": "blocked",                // blocked | attention | ready
  "label": "Merge bloqueado",
  "reason": "3 achados em high ou acima",
  "detail": "O mais grave é SEC002 (alto) em api/db.ts:42. Limite: failOn=high.",
  "counts": { "critical": 0, "high": 3, "medium": 1, "low": 1, "info": 0 },
  "exitCode": 1
}
```

| Condição | `status` | `exitCode` |
| --- | --- | --- |
| ≥ 1 achado com severidade ≥ `failOn` | `blocked` | 1 |
| nenhum bloqueio, mas ≥ 1 achado ≠ `info` | `attention` | 0 |
| nenhum achado, ou só `info` | `ready` | 0 |

### 3.6 Review

```jsonc
{
  "id": "rv_ae8681c1db57",
  "version": 1,
  "createdAt": "2026-10-22T12:00:00.000Z",
  "durationMs": 183,
  "source": "diff",                 // diff | github | web | demo:<id>
  "repo": null,                     // com --pr: { repo, number, title, url, commit, draft }
  "stats": { /* §3.1 */ },
  "context": {
    "project": "greenlight", "learned": true,
    "languages": [{ "language": "ts", "files": 2 }],
    "testFramework": "node:test",
    "testsChanged": ["api/webhooks.test.ts"], "sourceChanged": ["api/webhooks.ts"],
    "conventions": null, "houseRules": 0,
    "configSource": ".greenlight.json", "configWarnings": []
  },
  "engine": {
    "name": "greenlight", "version": "1.0.0", "deterministic": true,
    "rules": 42, "coreRules": 42,
    "ruleErrors": [],                 // [{ ruleId, message }] — nunca derruba a revisão
    "llm": { "enabled": false, "provider": "off", "model": null, "status": "disabled",
             "durationMs": 0, "error": null, "redactions": 0, "diffTruncated": false }
  },
  "checks": [ /* 4 × §3.4 */ ],
  "verdict": { /* §3.5 */ },
  "findings": [ /* §3.2, ordenado por severidade e linha */ ],
  "summary": "1 arquivo, +11 −0. 5 achados — 3 alto · 1 médio · 1 baixo. Merge bloqueado…",
  "suppressed": { "total": 97, "inCode": 0, "byException": 97, "dismissed": 0 },
  "config": { "failOn": "high", "maxLineLength": 140, "testsRequired": true,
              "exceptions": 2, "customRules": 0, "forbiddenImports": 0, "github": {} }
}
```

`summary` é **determinístico** (contagem + veredito + top 3). Quando o LLM está ligado e devolve
resumo válido, ele é prefixado ao determinístico — nunca o substitui.

### 3.7 Erros

`ReviewError` carrega `code` e `status`:

| `code` | Quando | HTTP |
| --- | --- | --- |
| `EMPTY_DIFF` | texto vazio ou só espaços | 400 |
| `INVALID_DIFF` | nenhum arquivo reconhecido | 400 |
| `DIFF_TOO_LARGE` | acima do limite configurado | 413 |
| `REVIEW_FAILED` | pipeline não produziu resultado | 500 |
| `CONFIG_INVALID` | `.greenlight.json` ilegível | 400/500 |

Mensagens são em pt-BR e dizem o que fazer ("Envie o diff unificado em `diff`.").

---

## 4. Motor de regras

### 4.1 Catálogo (42 regras)

Severidade é o **padrão** da regra; a regra pode rebaixar/elevar por resultado. "Bloqueia" =
`severity ≥ failOn` com o padrão `failOn=high`.

**Segurança (18)**

| ID | Regra | Sev. | Linguagens | Bloqueia |
| --- | --- | --- | --- | --- |
| SEC001 | Segredo hardcoded | critical | todas | ✅ |
| SEC002 | Injeção de SQL | high | js, ts, py, php, java, ruby, go, csharp | ✅ |
| SEC003 | Injeção de comando | high | js, ts, py, rb, go, java | ✅ |
| SEC004 | Execução dinâmica de código | high | js, ts | ✅ |
| SEC005 | XSS por HTML dinâmico | high | js, ts | ✅ |
| SEC006 | Criptografia fraca | medium | js, ts, py, java, php, ruby, go | — |
| SEC007 | TLS desabilitado | high | js, ts, py, go, java, csharp, php, shell | ✅ |
| SEC008 | Aleatoriedade insegura | medium | js, ts, py | — |
| SEC009 | Path traversal | high | js, ts, py, go, rb | ✅ |
| SEC010 | Desserialização insegura | high | py, rb, php, js, ts, java | ✅ |
| SEC011 | SSRF | medium | js, ts, py, go, java, php | — |
| SEC012 | Redirect aberto | medium | js, ts, py, php, go | — |
| SEC013 | Segredo em log | medium | js, ts, py, rb, go, php, java | — |
| SEC014 | Cookie inseguro | medium | js, ts, py, php, java, go | — |
| SEC015 | JWT sem verificação | high | js, ts, py, java, go, php | ✅ |
| SEC016 | Injeção NoSQL | high | js, ts, py, php, ruby | — |
| SEC017 | CORS permissivo | medium | js, ts, py, go, java, php | — |
| SEC018 | Poluição de protótipo | medium | js, ts | — |

**Bugs (9)**

| ID | Regra | Sev. | Bloqueia |
| --- | --- | --- | --- |
| BUG001 | Retry sem backoff | medium | — |
| BUG002 | Erro engolido | medium | — |
| BUG003 | Igualdade frouxa | low | — |
| BUG004 | `parseInt` sem base | low | — |
| BUG005 | Promise não aguardada | medium | — |
| BUG006 | Callback assíncrono em `forEach` | medium | — |
| BUG007 | Limite de array off-by-one | medium | — |
| BUG008 | `setTimeout` com string | medium | — |
| BUG009 | Executor `async` em `Promise` | medium | — |

**Qualidade / Lint (11)**

| ID | Regra | Sev. | Nota |
| --- | --- | --- | --- |
| LNT001 | `console.log` esquecido | low | ignora arquivo de teste |
| LNT002 | `debugger` no código | medium | — |
| LNT003 | TODO ou FIXME | info | `commentsOnly` |
| LNT004 | Supressão de tipos (`@ts-ignore`) | low | ts |
| LNT005 | Uso de `any` | low | ts |
| LNT006 | Linha longa | info | limite configurável |
| LNT007 | Espaço no fim da linha | info | — |
| LNT008 | `eslint-disable` | info | — |
| LNT009 | Declaração `var` | low | js/ts |
| LNT010 | `except` sem tipo | medium | py |
| LNT011 | `alert` no código | low | js/ts |

**Testes (4)**

| ID | Regra | Sev. | Nota |
| --- | --- | --- | --- |
| TST001 | Mudança sem teste | medium | regra de diff |
| TST002 | Export sem teste | medium | regra de diff |
| TST003 | Teste focado ou pulado (`.only`, `skip`) | high | **bloqueia** |
| TST004 | Teste sem asserção | low | — |

Total: **42** regras; **11** bloqueiam com `failOn=high`.

### 4.2 Contrato de uma regra

```js
{
  id: 'SEC002',                      // [A-Z]{2,6}\d{3}, único e estável
  title: 'Injeção de SQL',
  severity: 'high',
  category: 'security',              // security | bug | quality | tests
  description: '...',
  languages: ['js', 'ts'],           // null = todas
  scope: 'line',                     // 'line' (default) | 'diff'
  testFilesOnly: false,
  commentsOnly: false,               // só linhas de comentário
  skipComments: true,                // default; false para regras que olham comentário
  run(ctx) { return [resultado] | resultado | []; }
}
```

`run` recebe, para regras de linha:
`{ content, file, line, lines, index, config, context }`
e, para regras de diff: `{ files, config, context }`.

Resultado:

```js
{ severity?, title?, message, why?, code?, line?, endLine?, confidence?, suggestion? }
```

`suggestion` é construída por `infoSuggestion(...)` ou `replaceSuggestion(...)` — nunca à mão.

Regras de casa (`house.js`) vêm da config (`rules.custom`, `rules.forbidImports`) e entram no mesmo
catálogo, com ids definidos pelo usuário.

### 4.3 Política anti-falso-positivo (obrigatória)

1. **Remova strings antes de casar.** `stripStrings(content)` para código; `isInsideStringLiteral`
   quando o padrão precisa olhar a string (ex.: `SEC002` em literal SQL).
2. **Não case palavra solta.** `console.log` precisa ser chamada: `(?:^|[;{])\s*console\.log\s*\(`.
   `SELECT` só conta com forma de consulta (`SELECT … FROM`, `INSERT INTO`, …).
3. **Comentário não é código** (`skipComments` default). Exceção explícita via `commentsOnly`.
4. **Arquivo de teste é contexto**: regras de estilo de produção (`LNT001`) não valem lá.
5. **Literais de regex não são código**: `stripRegexLiterals` antes de scans de segurança.
6. **Regra nova entra como `experimental`** até passar no bench com FP ≤ 10% (M1).

### 4.4 Fingerprint

```
id = sha256(ruleId \0 file \0 line \0 title \0 code.trim())[0..16]
```

Consequências que os testes garantem:

- Reexecutar a mesma revisão nos mesmos arquivos dá os mesmos ids.
- Mudar `message` ou `suggestion` **não** muda o id (dispensa continua válida).
- Mudar a linha **muda** o id (é outro ponto do código) — por isso a dispensa é por ocorrência.

---

## 5. Supressão

Achados suprimidos saem de `findings` e entram na contagem `suppressed`. Três camadas, avaliadas
nesta ordem:

| Camada | Declaração | Contada em | Alcance |
| --- | --- | --- | --- |
| 1. Inline | `greenlight-ignore SEC002` ou `greenlight-ignore-next-line ALL` na linha adicionada | `inCode` | aquela linha (ou a seguinte) |
| 2. Exceção | `.greenlight.json` → `exceptions: [{ rule, paths, reason }]` | `byException` | arquivos que casam com `paths` |
| 3. Dispensa | `gl dismiss <id>` / botão do painel / `.greenlight/memory.json` | `dismissed` | id do achado |

Regras de comportamento:

- A camada 1 só enxerga **linhas adicionadas** do diff; sem a palavra `ALL` ou um id, suprime tudo
  naquele ponto.
- Exceção exige `reason` não vazia na prática (o `doctor` avisa quando falta) — auditoria humana.
- `suppressed.total` = soma das três. O relatório mostra "N suprimidos" para não esconder o número.
- Dispensa é **por id**, então não sobrevive a mudança de linha — por design.

---

## 6. Configuração (`.greenlight.json`)

Lido da raiz do repositório (ou de `root` em `review()`); ambiente pode sobrepor `failOn` com
`GREENLIGHT_FAIL_ON`.

```jsonc
{
  "version": 1,
  "failOn": "high",
  "ignore": ["node_modules/**", "dist/**", "*.min.js"],
  "checks": { "lint": true, "bugs": true, "tests": true, "security": true },
  "tests": {
    "requireChangedTests": true,
    "testFilePatterns": ["**/*.test.js", "**/test_*.py"]
  },
  "rules": {
    "maxLineLength": 140,
    "forbidImports": [{ "package": "moment", "message": "use date-fns" }],
    "custom": [{
      "id": "HOUSE01", "pattern": "\\bTODO\\b", "message": "...",
      "severity": "medium", "files": ["src/**"], "suggestion": "..."
    }]
  },
  "security": { "excludePaths": ["test/**"] },
  "exceptions": [{ "rule": "LNT001", "paths": ["bin/**"], "reason": "saída do CLI" }],
  "github": {
    "requestChanges": false, "reviewDrafts": false,
    "maxInlineComments": 20, "checks": true
  },
  "llm": { "enabled": true, "model": null }
}
```

Validação e defaults:

| Campo | Default | Regra de validação |
| --- | --- | --- |
| `failOn` | `high` | precisa ser uma severidade conhecida; senão volta ao default com aviso |
| `ignore` | lista embutida | array de padrões; não pode ser string solta |
| `checks.*` | `true` | `false` desliga a checagem (status `skip`) |
| `tests.requireChangedTests` | `true` | `false` desliga TST001/TST002 |
| `rules.maxLineLength` | `140` | inteiro ≥ 40, senão default |
| `rules.custom[].id` | — | string ≤ 20 chars, `pattern` obrigatório |
| `github.maxInlineComments` | `20` | inteiro 0–100 |
| `llm.model` | null | ≤ 80 chars (truncado com aviso) |
| `llm.baseUrl` | **removido** | só por `OPENAI_BASE_URL`; config do repo não pode redirecionar a revisão |

Config inválida **nunca** derruba a revisão: gera `context.configWarnings` e segue com o default.

---

## 7. Veredito e bloqueio

- Severidades, da maior para a menor: `critical(5) > high(4) > medium(3) > low(2) > info(1)`.
- **Bloqueio** = achado com rank ≥ `failOn`. Default `high` ⇒ `critical` e `high` bloqueiam.
- **Checagem** (`scoring.js`):
  - `warnAt`: `lint` e `security` = `low`; `bugs` e `tests` = `medium`.
  - `fail` se `blocking > 0`; `warn` se existe achado ≥ `warnAt`; senão `pass`; `skip` se desligada.
- **Veredito**: ver tabela §3.5. `attention` **não** falha o CI de propósito: só o que é
  bloqueante derruba pipeline, o resto é decisão humana.
- O painel e o CLI mostram o mesmo rótulo: "Pronto para o merge" / "Atenção antes do merge" /
  "Merge bloqueado".

---

## 8. Camada LLM (opcional)

### 8.1 Ativação

| Variável | Efeito |
| --- | --- |
| `OPENAI_API_KEY` | provedor `openai` |
| `ANTHROPIC_API_KEY` | provedor `anthropic` |
| `OLLAMA_HOST` | provedor `ollama` (local) |
| `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `OLLAMA_MODEL` | modelo |
| `OPENAI_BASE_URL` | endpoint compatível (proxy, Azure, gateway) |
| `GREENLIGHT_LLM=off` | desliga mesmo com chave |
| `GREENLIGHT_LLM_TIMEOUT_MS` | timeout por chamada |
| `.greenlight.json` → `llm.enabled=false` | desliga para o repositório |

Precedência: `llm:false` na chamada > `GREENLIGHT_LLM=off` > chave de ambiente. Sem chave, status
`disabled` e o painel mostra "LLM: off" — o motor determinístico não perde nada.

Modelos padrão: `gpt-4o-mini`, `claude-3-5-haiku-latest`, `qwen2.5-coder:7b`.

### 8.2 Redação (obrigatória, antes de qualquer envio)

Substitui por marcador (`[REDIGIDO:…]`) e conta em `engine.llm.redactions`:

- chave privada PEM (bloco completo);
- token do GitHub (prefixos de token pessoal, app e refresh);
- chaves AWS, Slack, Google e Stripe (padrões por provedor);
- JWT (três segmentos codificados em base64url);
- par `chave/segredo/token/senha = "…"` com 8+ caracteres.

O prompt nunca inclui o diff inteiro sem limite; acima do orçamento ele é cortado e sinalizado com
`diffTruncated: true`.

### 8.3 Contrato de saída

O LLM devolve JSON com `summary` e `findings[]`. Validação antes de aceitar:

1. `file` precisa existir no diff; `line` precisa estar a ≤ 3 linhas de uma linha adicionada
   (`nearestLine`); fora disso, descarta.
2. `category` precisa ser uma das quatro; `severity` idem, senão `medium`.
3. Máximo de achados por revisão; excedente é ignorado.
4. Achado de LLM que coincide com regra no mesmo arquivo/linha/categoria é descartado (a regra vence).
5. Falha de rede, 429 ou 5xx: uma nova tentativa com backoff; depois disso, `status:'failed'` com
   `error` curta e **a revisão continua**.

`source: 'llm'` marca a origem; o painel mostra a etiqueta e nunca trata achado de LLM como bloqueio
determinístico na explicação.

---

## 9. CLI (`gl`)

| Comando | Função |
| --- | --- |
| `gl review [diff]` | revisa arquivo, `-` (stdin) ou o diff de `--pr` |
| `gl rules` | lista as 42 regras ativas |
| `gl sync` | indexa o repositório (`.greenlight/index.json`) |
| `gl dismiss <id>` | dispensa um achado da última revisão |
| `gl last [--json]` | mostra a última revisão salva |
| `gl doctor` | diagnostica config, chaves, índice e permissões |
| `gl help` / `gl --version` | ajuda / `1.0.0` |

Opções de `review`: `--json`, `--markdown`, `--quiet`, `--fail-on <nível>`, `--no-llm`,
`--apply <id> [--write]`, `--save`, `--pr <dono/repo#n>`, `--comment`.

Códigos de saída:

| Código | Significado |
| --- | --- |
| 0 | revisão concluída (`ready` ou `attention`) |
| 1 | `blocked` (achado ≥ `failOn`) |
| 2 | erro de uso: diff vazio, comando desconhecido, arquivo inexistente, JSON inválido |

Formatos:

- texto: veredito, resumo, achados agrupados por checagem, sugestão quando houver;
- `--markdown`: começa com `# 🟡 Atenção antes do merge` (ou 🟢/🔴) e traz tabela
  `| Checagem | Resultado |` — formato pronto para colar em PR;
- `--json`: objeto `Review` completo (§3.6), sem nada além;
- `--quiet`: só "Pronto para o merge" / "Merge bloqueado" / "Atenção antes do merge".

---

## 10. HTTP + SSE

Servidor nativo (`node:http`), sem framework. Bind padrão `0.0.0.0:3000` (`PORT`, `HOST`).

### 10.1 Endpoints

| Método | Rota | Corpo | Devolve |
| --- | --- | --- | --- |
| GET | `/api/health` | — | versão, uptime, nº de regras, estado de LLM/GitHub/índice, limites |
| GET | `/api/rules` | — | catálogo + config resumida + avisos |
| GET | `/api/scenarios` | — | 4 cenários (`id`, `title`, `subtitle`, `note`, `url`) |
| GET | `/api/config` | — | config efetiva (sem segredos) |
| GET | `/api/history` | — | últimas 20 revisões (id, veredito, contagem, ms) |
| GET | `/api/dismissed` | — | dispensas da sessão |
| DELETE | `/api/dismissed` | — | limpa dispensas |
| GET | `/api/github/status` | — | se app/webhook estão configurados |
| POST | `/api/review` | `{diff, scenarioId?, options?}` | `{review, demo}` |
| POST | `/api/review/stream` | idem | SSE (§10.2) |
| POST | `/api/apply` | `{diff, file, suggestion}` | `{diff}` corrigido |
| POST | `/api/dismiss` | `{finding, reason?}` | `{dismissed, demo}` |
| POST | `/api/github/webhook` | payload do GitHub | `{ok}` / `{ignored}` |

`options` aceita `{ llm: false, failOn, config }`.

### 10.2 SSE

Sequência de eventos em `/api/review/stream`:

```
event: stage      data: {type,id,label,status,detail,ms}   (running e done por etapa)
event: checks     data: [Check ×4]
event: findings   data: [Finding…]
event: summary    data: "…"
event: done       data: {type:'done', review: Review}
event: error      data: {error, code}                      (só em falha)
```

Heartbeat `: ping` a cada 15 s. Conexão encerrada pelo cliente interrompe o envio (`close`), sem
vazar timer. `cache-control: no-store`; sem compressão.

### 10.3 Limites e segurança

| Item | Valor | Origem |
| --- | --- | --- |
| Diff máximo | 512 KB (4 KB–4 MB) | `GREENLIGHT_MAX_DIFF_BYTES` |
| Corpo JSON | mesmo limite + 8 KB | — |
| Revisões por minuto por IP | 40 | `GREENLIGHT_RATE_LIMIT` |
| Rate limit de ações | janela separada | `createRateLimiter` |
| Resposta a excesso | 429 com `retry-after` | — |

Cabeçalhos: CSP (com `frame-ancestors 'self' https://*.e2b.app` para a prévia), `nosniff`,
`referrer-policy`, `cross-origin-opener-policy`, `permissions-policy`. Estáticos servidos por
**allowlist**; qualquer caminho fora dela é 404. Origem de `POST` é checada; `x-forwarded-for` só
para o rate limit.

---

## 11. GitHub App

### 11.1 Variáveis

| Variável | Uso |
| --- | --- |
| `GITHUB_APP_ID` | id do app |
| `GITHUB_PRIVATE_KEY` | PEM da chave (aceita `\n` escapado) |
| `GITHUB_WEBHOOK_SECRET` | HMAC do webhook |
| `GITHUB_TOKEN` | modo CLI `--pr`, sem app |
| `GITHUB_API_URL` | GitHub Enterprise (`…/api/v3`) |
| `GREENLIGHT_ALLOW_UNSIGNED_WEBHOOKS` | **só dev**; `doctor` reclama |

### 11.2 Fluxo

```
webhook (pull_request) ──▶ verifica HMAC ──▶ filtra evento/ação
      ──▶ JWT RS256 (10 min) ──▶ POST /app/installations/:id/access_tokens
      ──▶ GET /repos/:owner/:repo/pulls/:n/files ──▶ parseDiff
      ──▶ carrega .greenlight.json do repo (ref do PR)
      ──▶ review() ──▶ POST /pulls/:n/reviews (event, comments)
                    └─▶ POST /check-runs (conclusão + anotações)
```

Eventos: `opened`, `synchronize`, `reopened`, `ready_for_review`. Drafts são ignorados, salvo
`github.reviewDrafts: true`.

### 11.3 Payload da revisão

- **Comentário inline** por achado, no arquivo/linha do diff, com:
  - cabeçalho `**[SEV] RULEID — título**`;
  - `message` + `why`;
  - bloco ```` ```suggestion ```` quando `mode:'replace'` e a faixa está no diff;
  - rodapé explicando como suprimir (inline, exceção ou histórico).
- Limite de `github.maxInlineComments` (default 20) — o excedente vai no corpo da revisão.
- `event`: `REQUEST_CHANGES` se `github.requestChanges` e houver bloqueio; senão `COMMENT`.
- Se a API recusar comentário inline (422), publica um **issue comment** com a tabela de achados e
  segue: a revisão nunca é perdida por um comentário inválido.
- Corpo da revisão: veredito, resumo, tabela de checagens, link para o formato completo.

### 11.4 Check run

- `name: greenlight`, conclusão `success`/`neutral`/`failure` conforme o veredito.
- Anotações em lotes (limite por requisição), com `path`, `start_line`, `end_line`, `annotation_level`.
- Se `github.checks: false`, só a review é publicada.

### 11.5 Segurança

- HMAC-SHA256 em **tempo constante**; corpo cru preservado para o cálculo.
- Token de instalação nunca é logado; expira em ~1 h e é reusado enquanto válido (M4 adiciona cache).
- Payload > limite é rejeitado antes de qualquer chamada externa.
- Nada de execução de comando a partir de webhook, em nenhuma hipótese.

---

## 12. Painel na landing

Contrato entre `index.html` + `agent/agent.js` e a API:

| Elemento | Fonte | Comportamento |
| --- | --- | --- |
| `#agent-scenarios` | `GET /api/scenarios` | botão por cenário; carrega `/samples/<id>.diff` |
| `#agent-diff` | `samples/*.diff` | textarea editável (US-ASCII, sem auto-formatação) |
| `#agent-run` | `POST /api/review/stream` | desabilita durante execução; `AbortController` por runId |
| `#agent-stages` | `event: stage` | chip por etapa, `ms` real, tick visual de 250 ms |
| `#agent-checks` | `event: checks` | 4 linhas com status e contagem |
| `#agent-findings` | `event: findings` | cartão por achado: severidade, arquivo:linha, `why`, sugestão |
| `#agent-verdict` | `event: done` | rótulo + `aria-live="polite"` |
| `#agent-summary` | `event: summary` | texto do resumo |
| `#agent-pill` | `/api/health` | "LLM: on/off", versão do motor |
| Aplicar | `POST /api/apply` | envia diff + sugestão; recebe diff novo; re-revisa |
| Dispensar | `POST /api/dismiss` | remove o cartão; mostra "1 dispensado" |
| Reset | `DELETE /api/dismissed` + recarga | volta ao estado inicial |

Regras de implementação:

- Renderização **só com `textContent`**; nenhum `innerHTML` com dado de servidor.
- Falha de rede mostra mensagem em pt-BR e mantém o painel utilizável.
- Sem JS: `<noscript>` explica como subir o servidor; a landing continua legível.
- `prefers-reduced-motion` desliga o tick das etapas.
- A seção não pode prometer nada que a API não faça (ver PLAN §2, princípio 6).

---

## 13. Desempenho

Medido no próprio repositório (52 arquivos, 9 951 adições, 10 364 linhas de diff): **183 ms** no
motor determinístico, com LLM desligado.

| Cenário | Alvo | Nota |
| --- | --- | --- |
| Diff de 500 linhas, sem LLM | ≤ 60 ms p50 | parser + 42 regras |
| Diff de 2 000 linhas, sem LLM | ≤ 500 ms p95 | M2 não pode piorar |
| Diff de 10 000 linhas | ≤ 2 s | streaming já ajuda a percepção |
| Primeiro byte do SSE | ≤ 50 ms | `stage: parse` sai antes de analisar |
| Revisão com LLM | + 1–4 s | sempre depois do determinístico |

Complexidade esperada: O(linhas × regras). Nada de varrer o diff dentro de regra de linha; para
isso existe `scope:'diff'`.

---

## 14. Invariantes e compatibilidade

1. **Node ≥ 20**, CommonJS, **zero dependências de runtime**.
2. `review()` é pura em relação ao ambiente: sem rede, sem escrita, sem `process.exit`, exceto pela
   camada LLM (opt-in) e leitura de config.
3. Nenhuma regra derruba a revisão: exceção em `run` vira item em `engine.ruleErrors`.
4. `ruleId` e `id` de achado são **estáveis**; renomear regra é quebra de contrato.
5. Todo achado tem `file` e `line` válidos (linha adicionada do diff) — o LLM é o único que pode
   apontar linha próxima, e só dentro de ±3.
6. `verdict` é função determinística de `findings` + `config`.
7. A landing e o CLI mostram os mesmos três rótulos de veredito.
8. Campos novos em `Review`/`Finding` são **aditivos**; remover ou renomear exige major.

---

## 15. Matriz de testes

| Arquivo | Cobre |
| --- | --- |
| `test/diff.test.js` | parsing, hunks, binário, rename, CRLF, contagem |
| `test/security.test.js` | 18 regras, falso positivo em string/comentário, redação |
| `test/bugs.test.js` | 9 regras, casos negativos parecidos |
| `test/review.test.js` | pipeline, estágios, veredito, supressões, dedupe, fingerprint |
| `test/llm.test.js` | provedores falsos, redação, validação de arquivo/linha, fallback |
| `test/github.test.js` | JWT, headers, comentário com `suggestion`, 422 → issue comment |
| `test/github-app.test.js` | HMAC, eventos, drafts, check run, rate limit |
| `test/server.test.js` | rotas, limites, rate limit, SSE, estáticos, CSP |
| `test/cli.test.js` | comandos, flags, exit codes, stdin, `--apply`, `doctor` |
| `test/env.test.js` | carregamento de `.env`, precedência, parsing de `\n` |

Cobertura de contrato exigida: **todo endpoint de §10.1, toda flag de §9 e todo evento de §10.2 tem
pelo menos um teste** — incluindo caminho de erro.

---

## 16. Glossário

| Termo | Definição |
| --- | --- |
| **achado** (finding) | problema detectado, com severidade, local e explicação |
| **checagem** (check) | agrupamento fixo de achados: Lint, Bugs, Testes, Segurança |
| **veredito** | resultado final: `ready`, `attention` ou `blocked` |
| **supressão** | declarar que um achado é aceitável (inline, exceção ou dispensa) |
| **sugestão** | correção proposta (`replace`), explicação (`info`) ou esqueleto de teste (`test`) |
| **hunk** | bloco contíguo de alteração dentro de um arquivo |
| **failOn** | severidade mínima que bloqueia o merge |
| **fingerprint** | id de 16 hex derivado do conteúdo do achado |
| **regra da casa** | regra definida no `.greenlight.json` do repositório |
| **índice** | resultado do `gl sync`: linguagens, framework de teste, convenções |
