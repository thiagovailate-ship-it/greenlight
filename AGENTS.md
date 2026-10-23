# AGENTS.md

> Manual de operação para quem mexe neste repositório — pessoa ou agente de código.
> Leia **SPECS.md** antes de alterar contrato; leia **PLAN.md** antes de escolher o que fazer.
> Este arquivo é curto de propósito: são as regras que evitam retrabalho.

---

## 0. Contexto em 60 segundos

Greenlight é um **agente de revisão de pull request**. Ele lê um diff unificado e devolve um veredito
(`ready` / `attention` / `blocked`) com achados por severidade, sugestões de correção e sugestões de
teste. Roda em três superfícies: CLI (`gl`), servidor HTTP/SSE (que serve a landing) e GitHub App.

Três invariantes de produto:

1. **Zero dependências de runtime.** `node_modules` não existe na instalação. Node ≥ 20.
2. **Determinismo.** O que bloqueia merge é regra local e reprodutível; o LLM é opcional e nunca
   decide sozinho.
3. **Honestidade.** O que a interface promete precisa existir; o que é fictício fica marcado.

---

## 1. Regras de ouro (não negociáveis)

| # | Regra | Por quê |
| --- | --- | --- |
| 1 | **Precisão > cobertura.** Regra nova que gera ruído é regressão, mesmo que pegue um bug real. | Ruído treina o time a ignorar o agente. |
| 2 | **Nunca adicione dependência de runtime.** Opcional com `try { require() }` e fallback é aceito. | Instalação limpa, sem supply chain. |
| 3 | **Nunca escreva segredo literal no código, em teste ou em fixture.** Monte em runtime. | O push protection do GitHub bloqueia o push e varre o histórico (GH013). |
| 4 | **`textContent`, nunca `innerHTML`, para dado vindo do servidor.** | O painel renderiza código de PR alheio: é sink de XSS. |
| 5 | **Toda regra usa `stripStrings`/`isInsideStringLiteral` antes de casar padrão.** | Strings de exemplo viram falso positivo (já aconteceu com SEC002 e LNT001). |
| 6 | **Contrato mudou → SPECS.md mudou no mesmo commit.** | O documento é a fonte da verdade para quem integra. |
| 7 | **Erro de regra não derruba revisão.** Capture, registre em `engine.ruleErrors`, siga. | Uma regra quebrada não pode parar um merge gate. |
| 8 | **Nada de rede em teste.** Servidores falsos, `fetch` injetado. | Teste precisa rodar offline e em 3 s. |
| 9 | **Copy em pt-BR, identificador em inglês.** | É o padrão do produto e do código. |
| 10 | **Não invente número em marketing.** Stats/preços da landing são fictícios e assim ficam. | Foi o vício que o projeto veio corrigir. |

---

## 2. Mapa do repositório

| Caminho | É dono de | Não mexa sem |
| --- | --- | --- |
| `agent/diff.js` | parsing do diff, hunks, linhas, binários | entender `fileLines()` e contagem `+/-` |
| `agent/review.js` | orquestração, pipeline, supressões, dedupe | SPECS §2/§5 |
| `agent/rules/*.js` | catálogo de regras (42) | ler §5.1 abaixo |
| `agent/rules/util.js` | helpers de casamento, `stripStrings`, sugestões | — |
| `agent/findings.js` | `createFinding`, severidades, fingerprint | contrato `Finding` (SPECS §3.2) |
| `agent/scoring.js` | checagens, veredito, resumo | contrato `Review` (SPECS §3.6) |
| `agent/config.js` | `.greenlight.json`, defaults, validação | SPECS §6 |
| `agent/context.js` / `learn.js` | índice aprendido, convenções | — |
| `agent/llm.js` | provedores, redação, validação de saída | SPECS §8 |
| `agent/suggestions.js` / `patch.js` | formato de sugestão, aplicação | fingerprint estável |
| `agent/github.js` | cliente da API do GitHub | SPECS §11 |
| `agent/report.js` | saída texto/JSON/Markdown | — |
| `server/index.js` | rotas, estáticos, sessão | SPECS §10 |
| `server/http.js` | headers, corpo, rate limit, SSE | não afrouxe CSP sem motivo |
| `server/github-app.js` | webhook, JWT, token de instalação, comentários, check run | SPECS §11 |
| `bin/greenlight.js` | CLI, exit codes | SPECS §9 |
| `agent/agent.js` | painel da landing (browser, ES5) | sem `innerHTML`, sem módulos |
| `samples/*.diff` | cenários da demo | precisam continuar realistas |
| `test/*.test.js` | 101 testes | padrão `node:test` |

**`index.html` e `styles.css`** são a landing; o painel vive na seção `#agent`. `agent/agent.js` é
carregado pelo `index.html` **e** pelo servidor — não use sintaxe que um browser antigo não entenda.

---

## 3. Comandos

```bash
npm test                      # 101 testes, node:test, sem deps
npm start                     # servidor em :3000 (landing + API)
npm run dev                   # idem, com --watch
node bin/greenlight.js review samples/retry.diff
node bin/greenlight.js review samples/secret-sql.diff --json
node bin/greenlight.js review --pr dono/repo#123 --comment
node bin/greenlight.js doctor

# dogfood: revisar o próprio branch contra main
git add -A && git diff --cached main > /tmp/branch.diff
node bin/greenlight.js review /tmp/branch.diff --json
```

Aliases: `gl` = `greenlight` (bin). `npm run bench` existe a partir do M1 (PLAN §5).

**Antes de dizer "pronto":** `npm test` verde, auto-revisão sem achado bloqueante, e um olhar no
painel (`/agent`) se a mudança toca `agent/agent.js`, `styles.css` ou `server/`.

---

## 4. Loop de trabalho

1. **Escolha uma onda do PLAN.md.** Não invente escopo paralelo.
2. **Leia o contrato afetado em SPECS.md.** Se não existir, escreva-o primeiro.
3. **Escreva o teste antes ou junto** — no mesmo arquivo de teste da área. Bug de regra vira teste
   de regressão com o diff mínimo que o reproduz.
4. **Rode `npm test`.** Se falhou por regra nova pegando fixture, conserte a regra, não o fixture.
5. **Meça** (quando mexe em regra): bench, e o número vai para o relatório do PR.
6. **Atualize docs** (README/SPECS/PLAN) no mesmo commit.
7. **Auto-revisão** do branch, depois commit e push na branch da sessão.

---

## 5. Receitas

### 5.1 Adicionar uma regra

```js
// agent/rules/bugs.js — dentro do array exportado
{
  id: 'BUG010',                 // 3 letras de categoria + 3 dígitos, único
  title: 'Título curto em pt-BR',
  severity: 'medium',           // critical | high | medium | low | info
  category: 'bug',              // security | bug | quality | tests
  description: 'O que a regra detecta.',
  languages: ['js', 'ts'],      // null = todas
  run({ content, file, line, lines, index }) {
    const clean = stripStrings(content);      // obrigatório
    if (!PADRAO.test(clean)) return [];
    if (file.isTest) return [];               // quando fizer sentido
    return [{
      severity: 'medium',
      message: 'O que aconteceu nesta linha.',
      why: 'Consequência concreta — não repita a mensagem.',
      code: truncate(content),
      confidence: 0.85,
      suggestion: replaceSuggestion('Título da correção', 'javascript', 'código novo', line.newLine, line.newLine),
    }];
  },
}
```

Checklist da regra:

- [ ] Casou só no código, nunca em comentário/string de exemplo.
- [ ] Testada com: caso positivo, caso negativo parecido, caso em arquivo de teste.
- [ ] Id e severidade refletem o risco real (não infle para "bloquear").
- [ ] Sugestão **aplicável** (`mode: 'replace'`) só quando o código é autocontido; senão `info`.
- [ ] Adicionada ao README (tabela de regras) — se a tabela existir — e coberta pelo bench (M1).
- [ ] `gl review` no próprio branch continua limpo (ou a exceção tem motivo).

### 5.2 Regra que só vale em comentário

Use `commentsOnly: true` (ver `LNT003`). Regra que só vale em teste: `testFilesOnly: true`.
Regra de diff inteiro: `scope: 'diff'` e `run({ files, config, context })`.

### 5.3 Adicionar endpoint

1. Rota em `server/index.js`, dentro do bloco de API (antes do fallback de estáticos).
2. Passe por `guard()` para métodos que gastam CPU.
3. Corpo via `readJson(req, limit)`; nunca `JSON.parse` cru sem limite.
4. Resposta com `sendJson` (nunca monte header na mão).
5. Teste em `test/server.test.js`: sucesso, payload inválido, limite excedido.
6. Documente em SPECS §10 e no README.

### 5.4 Mudar um contrato

Ordem: SPECS.md → código → testes → README. Se for quebra de compatibilidade, suba `version` em
`package.json` e registre no PR. Não renomeie `ruleId` existente: fingerprint e exceções dependem dele.

### 5.5 Nova linguagem

1. Adicione o nome em `agent/diff.js` (extensão → linguagem) e em `file.language`.
2. Ajuste `isCommentLine` para os comentários da linguagem.
3. Só então estenda regras: `languages: [... 'go']`, e teste com diff real.
4. Cuidado com `//` dentro de string e com template literal — o tokenizador do M2 resolve isso;
   até lá, `stripStrings` é obrigatório.

### 5.6 Nova integração

Crie `agent/integrations/<nome>.js` com a interface `verify` / `parse` / `publish` (PLAN M5). Nunca
importe o cliente do GitHub dentro da integração nova: duplique o mínimo ou extraia um cliente HTTP
compartilhado.

---

## 6. Testes: padrões e armadilhas

- Framework: `node:test` + `node:assert/strict`. Sem runner externo, sem snapshot mágico.
- Nome do teste em pt-BR, descritivo: `'SEC002 ignora consulta parametrizada'`.
- Fixtures de diff: string template com `+`/`-` reais. Prefira montar o diff no teste a criar arquivo.
- **Segredos**: use `FAKE_STRIPE_KEY`/`FAKE_GITHUB_TOKEN`/`FAKE_PRIVATE_KEY` de `test/helpers.js`,
  que montam o valor em runtime. Nunca cole o literal.
- **LLM**: injete `fetch` falso; nunca chame rede.
- **GitHub**: `fakeGitHub` responde por fila; teste `429`, `401`, `422` e payload duplicado.
- **CLI**: use `spawnSync` com `cwd` do repo; stdin precisa ser um diff inerte (arquivo de docs) se o
  caso espera `ready`.
- **jsdom** (se precisar): `NODE_PATH=<repo>/node_modules`, requires absolutos; jsdom não tem
  `matchMedia`/`Response`/`TextDecoder` — não dependa deles sem guarda.
- Teste que depende de tempo real deve ter margem (>= 50 ms), nunca igualdade exata.

---

## 7. Segurança e privacidade

- **Segredo**: `SEC001` existe para o produto; não replique o padrão em fixture.
- **LLM**: antes de enviar, o diff passa por redação (`llm.js`). Não remova essa etapa, nem permita
  `baseUrl` vindo do `.greenlight.json` — só de variável de ambiente. Um PR não pode redirecionar
  dados da revisão.
- **Webhook**: valide HMAC em tempo constante; `GREENLIGHT_ALLOW_UNSIGNED_WEBHOOKS` só em dev, e o
  `doctor` precisa reclamar se estiver ligado.
- **Estáticos**: allowlist explícita. Nada de `serve-static` caseiro com `..` no caminho.
- **CSP**: `frame-ancestors` precisa manter `https://*.e2b.app` — a prévia roda em iframe.
- **Execução de comando** (M3): só por flag explícita, nunca em webhook, com timeout.

---

## 8. Estilo

- 2 espaços, aspas simples, ponto e vírgula, CommonJS (`require`/`module.exports`).
- Sem `console.log` em código de produção — CLI/servidor usam o logger de saída; regra `LNT001` pega.
- Linhas ≤ 140 caracteres (`LNT006`), com exceções declaradas por `commentsOnly`/config.
- Funções pequenas, retorno cedo, sem classe onde um objeto basta.
- Comentário explica **por quê**, não o quê. Comentário em pt-BR, curto.
- Erros do usuário em pt-BR, com ação: "envie o diff em `diff` ou como texto puro", não "invalid input".
- Nada de emoji em código; no relatório/CLI, os símbolos já existentes (`✅`, `⚠️`, `⛔`) são bem-vindos.

---

## 9. Git, commits e PR

- Branch da sessão: `arena/cacf5ffe-greenlight`. **Nunca** crie outra branch nem troque de branch.
- Commit no imperativo, em pt-BR, com escopo: `regras: SEC002 ignora consulta parametrizada`.
- Um commit por assunto; não misture refactor com mudança de comportamento.
- Push só para a branch da sessão. O PR #1 é o histórico desta produção.
- Antes do push: `git diff --cached | grep -nE 'sk_live|ghp_|AKIA|BEGIN .*PRIVATE KEY'` — se aparecer,
  **pare** e monte o valor em runtime.

---

## 10. Becos sem saída (não repita)

| Tentativa | Por que falhou | O que fazer |
| --- | --- | --- |
| Express/Docker/API em processo separado | O preview roda em iframe sem rede própria | `createServer` nativo, same-origin |
| `node --test "test/**/*.test.js"` | Node 22 já descobre recursivo; glob quebra | `node --test` |
| Casamento de palavra solta na linha | Falso positivo em string/regex de exemplo | `stripStrings` + `isInsideStringLiteral` |
| `innerHTML` com texto do diff | XSS no painel | `textContent` |
| Literal de chave em fixture | GH013 bloqueia push e varre histórico | `FAKE_*` em runtime |
| LLM decidindo bloqueio | Instável, caro, não auditável | LLM só sugere; veredito é determinístico |
| `express.static` | Path traversal | Allowlist explícita |
| Dedupe por mensagem | Dispensa perdia efeito quando o texto mudava | Fingerprint sha256 estável |
| jsdom a partir de `/tmp` | Não resolve módulos | `NODE_PATH` + require absoluto |

---

## 11. Checklist antes de dizer "pronto"

- [ ] `npm test` 101+ verdes (e o teste novo cobre erro, não só sucesso).
- [ ] Auto-revisão do branch sem bloqueio; exceções com motivo no `.greenlight.json`.
- [ ] Se mexeu em regra: bench antes/depois, sem regressão de FP.
- [ ] Se mexeu em contrato: SPECS.md atualizado; README também, se for visível ao usuário.
- [ ] Se mexeu no painel: abrir `/agent`, testar cenário, aplicar, dispensar, recarregar.
- [ ] Nenhuma dependência nova em `dependencies`.
- [ ] Nenhum segredo literal, nenhum `innerHTML`, nenhum `eval`.
- [ ] Mensagem de commit explica o efeito, não o arquivo.
