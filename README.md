# Greenlight

Landing page **e** agente de revisão de código para pull requests. A página apresenta o
produto; a seção **“A demo acima é uma animação. Esta aqui roda.”** (`/#agent`) executa o
motor de verdade contra o servidor local.

- **Front-end:** HTML, CSS e JavaScript puros, sem build.
- **Agente:** Node.js ≥ 20, **zero dependências de runtime**.
- **LLM:** opcional (OpenAI, Anthropic ou Ollama). Sem chave, a revisão continua 100%
  determinística.
- **GitHub:** GitHub App real (webhook → revisão → comentários inline com `suggestion` e
  check run).

```bash
npm start          # http://localhost:3000
npm test           # 101 testes (node:test)
npm run sync       # aprende o repositório (índice + convenções)
node bin/greenlight.js review samples/retry.diff
```

Planejamento e contratos ficam em **[PLAN.md](PLAN.md)** (o que vem depois e por quê),
**[SPECS.md](SPECS.md)** (os contratos que o código cumpre) e **[AGENTS.md](AGENTS.md)** (como
mexer no repositório sem quebrar as regras da casa).

---

## O que a landing promete × o que existe no repositório

| Promessa da página | Estado |
| --- | --- |
| Revisão de PR em segundos, antes do humano | ✅ motor local + API HTTP/SSE |
| Comentários inline com correção em um clique | ✅ regras geram `suggestion` aplicável; o GitHub recebe bloco ```suggestion |
| Análise de segurança | ✅ 18 regras (segredos, SQL, XSS, TLS, JWT, SSRF, path traversal…) |
| Sugestões de teste | ✅ esqueleto executável no framework detectado |
| Aprende a base de código | ✅ `gl sync` indexa linguagens, testes e convenções; `.greenlight.json` traz regras da casa |
| Checagens bloqueando o merge | ✅ quatro checagens + `failOn` + check run no GitHub |
| Vive no terminal | ✅ `gl review`, `gl rules`, `gl sync`, `gl dismiss`, `gl doctor` |
| GitHub App / GitLab / Slack | ✅ GitHub App completo · ⚠️ GitLab e Slack ainda não implementados |
| Números da faixa de stats, preços, uptime | 🎭 continuam copy de marketing da landing |

O painel ao vivo mostra o pipeline real: cada chip de etapa é um evento SSE emitido pelo
servidor, com a duração medida naquela execução.

---

## Estrutura

```
index.html            landing page + seção do agente ao vivo
styles.css            tokens, componentes, breakpoints e preferências
main.js               comportamento da landing (menu, demo, count-ups, reveals)
agent/agent.js        cliente do painel ao vivo (fala com /api/*)
agent/                motor de revisão (Node, sem dependências)
  diff.js             parser de diff unificado com números de linha
  rules/              42 regras: security, bugs, quality, tests + regras da casa
  review.js           pipeline (parse → contexto → regras → LLM → veredito)
  suggestions.js      geração de testes por framework
  patch.js            aplica uma correção sugerida no próprio diff
  llm.js              camada opcional com redação de segredos
  github.js           cliente da API: JWT, PR, comentários inline, check run
  learn.js            índice do repositório (gl sync)
  memory.js           dispensas persistentes (.greenlight/memory.json)
server/               HTTP + SSE, sem frameworks; github-app.js trata o webhook
bin/greenlight.js     CLI (gl)
samples/              PRs de exemplo usados na página
test/                 101 testes de unidade, integração e CLI
PLAN.md               roadmap por ondas, métricas e Definition of Done
SPECS.md              contratos de dado, API, CLI, GitHub App e painel
AGENTS.md             manual de operação para quem (ou o que) mexe no código
```

---

## O agente

### 1. Motor determinístico (sempre ligado)

42 regras escritas à mão. Cada uma olha apenas as **linhas adicionadas** do diff — o que
mantém os comentários no lugar certo e reduz ruído.

| Categoria | Regras | Exemplos |
| --- | --- | --- |
| Segurança | `SEC001`–`SEC018` | segredo hardcoded, SQL/command injection, XSS, TLS desligado, JWT sem verificação, path traversal |
| Bugs | `BUG001`–`BUG009` | retry sem backoff, erro engolido, `parseInt` sem radix, `forEach(async)`, promise não aguardada |
| Qualidade | `LNT001`–`LNT011` | `console.log`, `debugger`, `any`, `var`, linha longa, espaço no fim |
| Testes | `TST001`–`TST004` | diff sem teste, export não coberto, `.only`/`.skip`, teste sem asserção |
| Regras da casa | `HOU001`, custom | import proibido, padrões definidos em `.greenlight.json` |

Regras que identificam um bloco produzem **correção aplicável** (`patch.js` reescreve o
diff e a revisão roda de novo). O painel usa esse caminho no botão *Aplicar correção*.

### 2. Contexto aprendido

`npm run sync` grava `.greenlight/index.json` (ignorado pelo git) com linguagens,
framework de teste, scripts, convenções observadas (indentação, aspas, ponto e vírgula) e
o resumo do README. O contexto entra na revisão e no prompt do LLM — sem clonar nada em
tempo de webhook.

### 3. LLM opcional

| Provedor | Como ligar |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` (modelo: `OPENAI_MODEL`, padrão `gpt-4o-mini`) |
| Anthropic | `ANTHROPIC_API_KEY` |
| Ollama | `OLLAMA_HOST` (padrão `http://127.0.0.1:11434`) |

Garantias:

- **Segredos são redados antes de sair da máquina** (chaves privadas, tokens GitHub/AWS/
  Slack/Stripe/Google, JWT e atribuições `senha = "…"`).
- O modelo só pode apontar **arquivo e linha que existem nas linhas adicionadas**; o que
  não casar é descartado.
- Achado do LLM na mesma linha e categoria de uma regra é deduplicado (a regra vence).
- Resposta inválida, timeout (25s) ou erro HTTP não derrubam a revisão: `engine.llm.status`
  vira `failed` e o veredito determinístico permanece.
- `GREENLIGHT_LLM=off` desliga tudo; `llm.enabled: false` no `.greenlight.json` tem o mesmo
  efeito. `baseUrl` **não** é aceito do repositório — só de `OPENAI_BASE_URL`, para um PR
  não redirecionar os dados da revisão.

### Pipeline

```
diff ──► parse ──► contexto ──► lint ──► segurança ──► bugs ──► testes ──► [LLM] ──► veredito
         │            │            │           │           │          │
         └── eventos SSE com duração real de cada etapa; o cliente só renderiza o que chega
```

### Veredito

| `failOn` (padrão `high`) | Resultado |
| --- | --- |
| algum achado ≥ `failOn` | 🔴 **Merge bloqueado**, exit code 1, check run `failure` |
| achados abaixo de `failOn` | 🟡 **Atenção antes do merge**, exit code 0, check `neutral` |
| nada relevante | 🟢 **Pronto para o merge**, check `success` |

---

## Configuração

`.greenlight.json` na raiz do repositório (o servidor também busca o arquivo do repo do PR
via API, no commit do head):

```json
{
  "failOn": "high",
  "ignore": ["node_modules/**", "dist/**", "samples/**"],
  "checks": { "lint": true, "bugs": true, "tests": true, "security": true },
  "tests": { "requireChangedTests": true },
  "rules": {
    "maxLineLength": 140,
    "forbidImports": [{ "package": "moment", "reason": "use date-fns" }],
    "custom": [
      {
        "id": "HOU900",
        "pattern": "console\\.log",
        "message": "Use o logger do time",
        "severity": "low",
        "files": ["src/**"]
      }
    ]
  },
  "security": { "excludePaths": ["test/**"] },
  "exceptions": [{ "rule": "SEC001", "paths": ["fixtures/**"], "reason": "dados falsos" }],
  "github": { "requestChanges": false, "reviewDrafts": false, "maxInlineComments": 20, "checks": true },
  "llm": { "enabled": true }
}
```

Silenciar pontualmente, no código:

```js
// greenlight-ignore-next-line LNT001
console.log('necessário aqui')

const token = '...' // greenlight-ignore SEC001
```

Dispensas com histórico compartilhável (comitável):

```bash
node bin/greenlight.js review samples/retry.diff --save
node bin/greenlight.js dismiss <id> --reason "aceito até a próxima release"
# grava .greenlight/memory.json; o achado não volta nas próximas revisões
```

---

## CLI

```bash
gl review samples/retry.diff              # revisão legível
gl review samples/secret-sql.diff --markdown
gl review . --json                        # stdin também funciona: gl review -
gl review --pr owner/repo#123             # busca o PR e revisa
gl review --pr owner/repo#123 --comment   # publica a revisão (GITHUB_TOKEN)
gl review samples/retry.diff --apply <id> # imprime o diff corrigido
gl review samples/retry.diff --apply <id> --write
gl rules                                  # catálogo com a config efetiva
gl sync                                   # aprende o repositório
gl doctor                                 # diagnóstico
```

Códigos de saída: `0` livre/atenção, `1` bloqueado, `2` erro de uso/configuração.

---

## API HTTP

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/api/health` | estado do motor, LLM, índice e GitHub App (sem segredos) |
| `GET` | `/api/rules` | catálogo e configuração efetiva |
| `GET` | `/api/scenarios` | PRs de exemplo (allowlist de `samples/`) |
| `POST` | `/api/review` | revisão completa em JSON |
| `POST` | `/api/review/stream` | mesma revisão em SSE (`stage`, `checks`, `findings`, `summary`, `done`) |
| `POST` | `/api/apply` | aplica uma correção `replace` e devolve o diff corrigido |
| `POST` | `/api/dismiss` · `DELETE /api/dismissed` | dispensas da sessão do painel |
| `GET` | `/api/history` | últimas 20 revisões (resumo) |
| `GET` | `/api/github/status` | se o App está configurado + passo a passo |
| `POST` | `/api/github/webhook` | recebe `pull_request`, assina e revisa |

Limites: corpo do diff 512 KB (`GREENLIGHT_MAX_DIFF_BYTES`), 40 revisões/min por IP
(`GREENLIGHT_RATE_LIMIT`). O servidor só serve uma allowlist de arquivos estáticos, aplica
CSP (`frame-ancestors` liberado para o preview do Arena) e nunca aceita origem cruzada nas
rotas de escrita.

---

## GitHub App

1. **Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Webhook URL: `https://SEU_DOMINIO/api/github/webhook`. Evento: **Pull request**.
3. Permissões: **Pull requests** (read/write), **Contents** (read), **Checks**
   (read/write), **Metadata** (read).
4. Gere a private key e defina no ambiente:

```bash
export GITHUB_APP_ID=123456
export GITHUB_PRIVATE_KEY="$(cat minha-chave.privada.pem)"
export GITHUB_WEBHOOK_SECRET=um-segredo-forte
# GitHub Enterprise: export GITHUB_API_URL=https://github.sua-empresa.com/api/v3
```

O servidor e o CLI leem `.env` automaticamente (sem sobrescrever variáveis já definidas no
ambiente) — copie `.env.example` para `.env`.

No `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`) o servidor:

1. valida a assinatura HMAC-SHA256 e responde `202` em menos de 10 s;
2. autentica como instalação (JWT RS256 → access token);
3. lê o `.greenlight.json` **do repositório do PR**, no commit do head;
4. revisa o diff e publica uma revisão com **comentários inline** — correções aplicáveis
   vão como bloco ```suggestion (botão “Commit suggestion” no GitHub);
5. cria o check run `Greenlight` com anotações por linha.

Rascunhos (`draft`) são ignorados por padrão (`github.reviewDrafts`).

---

## Landing page

Continua em HTML/CSS/JS puro, sem build, e funciona aberta direto do filesystem — exceto o
painel do agente, que precisa do servidor.

- **Menu mobile** com `aria-expanded`/`aria-controls`, `Escape` devolve o foco.
- **Demo do diff** (hero): 12 linhas escalonadas, comentário, 3 checagens e o chip verde.
  É uma animação de marketing; a seção `/#agent` é a versão real.
- **Painel ao vivo:** carrega os cenários de `/api/scenarios`, transmite o pipeline por SSE,
  renderiza achados com severidade/regra/linha, aplica correções no diff e permite
  dispensar. Falha de rede mostra instruções em vez de quebrar a página.
- **Count-ups** e **reveals** com `IntersectionObserver`; `prefers-reduced-motion` desliga
  animações e o painel continua funcional (sem transições).
- `prefers-reduced-transparency` troca o vidro por fundo opaco.
- Texto dinâmico entra sempre via `textContent`; nunca há `innerHTML` com dado do servidor.

### Rodar só a landing

Qualquer servidor estático serve a página:

```bash
python3 -m http.server 8080
```

O painel ao vivo mostrará “servidor fora do ar” e as instruções para subir o `npm start`.

---

## Testes

```bash
npm test
```

Cobrem: parser de diff, cada família de regras, supressões, exceções, dispensas, veredito,
`failOn`, patch de correção, LLM (provedor falso, redação, guardrails, falhas), JWT/
assinatura do GitHub, payload de revisão, check run, revisão completa de um PR contra uma
API do GitHub falsa, servidor (SSE, limites, rate limit, CSP, allowlist, webhook), `.env`
e CLI.

### O agente revisa a si mesmo

```bash
git diff main > /tmp/branch.diff
node bin/greenlight.js review /tmp/branch.diff
```

O diff completo deste repositório passa na própria revisão: **0 achados**, com as saídas do
CLI/servidor (`console.log`) e o estilo ES5 do cliente declarados como exceções no
`.greenlight.json` — 75 supressões rastreadas, não silenciosas.

---

## Limitações honestas

- As regras são **léxicas** (regex por linha), não AST/type-aware: pegam os padrões que
  mais aparecem em revisões e deixam falsos negativos para o LLM.
- GitLab e Slack aparecem na landing, mas **não** estão implementados.
- O GitHub App exige um host público com HTTPS para receber webhooks; não há marketplace
  nem fluxo de instalação de um clique.
- Preços, uptime, número de PRs e depoimentos continuam sendo conteúdo fictício do
  exercício de landing page.
- O painel mantém dispensas só na memória do processo; o histórico persistente é o do CLI.
