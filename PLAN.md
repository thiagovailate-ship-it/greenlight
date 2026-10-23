# PLAN.md — continuar a produção do agente

> Documento vivo. Ordem de leitura: **SPECS.md** (o que o agente é) → **AGENTS.md** (como mexer no
> código) → este arquivo (o que vem depois).
>
> Versão do motor: **1.0.0** · atualizado em 2026-10-22 · branch de trabalho:
> `arena/cacf5ffe-greenlight` (PR #1).

---

## 1. Onde estamos

O agente deixou de ser ficção: existe um motor determinístico de 42 regras, uma camada LLM opcional,
um GitHub App e um painel ao vivo embutido na landing. Números atuais:

| Indicador | Valor |
| --- | --- |
| Regras determinísticas | 42 (18 segurança, 9 bugs, 11 qualidade, 4 testes) |
| Testes automatizados | 101, todos passando (`npm test`) |
| Dependências de runtime | 0 |
| Auto-revisão do branch (52 arquivos, 9 951 adições) | `ready`, 0 achados, 183 ms |
| Cobertura de promessas da landing | GitHub App ✅ · GitLab ❌ · Slack ❌ · stats/preços 🎭 |

O que **não** está pronto, em ordem de impacto:

1. **Não sabemos a taxa de falso positivo.** As regras foram endurecidas à mão contra dois diffs
   reais (o do próprio projeto e os quatro cenários). Isso é anedota, não medida.
2. **As regras são léxicas.** Enxergam linha, não estrutura: não seguem variável, escopo nem fluxo.
   Todo o resto do roadmap herda esse teto.
3. **A correção aplicável não é verificada.** `Aplicar` reescreve o diff, mas ninguém roda os testes
   depois para provar que a correção funciona.
4. **O GitHub App nunca rodou contra o GitHub de verdade** — só contra uma API falsa nos testes.
5. **A memória do servidor morre com o processo.**
6. **GitLab e Slack continuam sendo promessa de marketing.**

---

## 2. Princípios de priorização

1. **Precisão antes de cobertura.** Uma regra nova que gera ruído custa mais do que dez padrões não
   detectados: ruído treina o time a ignorar o agente, e aí ele deixa de existir na prática.
2. **Determinismo primeiro.** Tudo que bloqueia merge precisa ser reproduzível offline e auditável.
   O LLM enriquece; ele não decide sozinho.
3. **Zero dependência de runtime é restrição de produto**, não preguiça: o agente precisa rodar num
   runner limpo, sem `npm install`, sem supply chain. Dependências só entram como *opcionais* com
   fallback (`try require(...)`).
4. **Toda promessa tem teste.** Se a landing diz "comentário inline com correção", existe um teste
   do payload que o GitHub recebe — não só do texto na tela.
5. **Nenhuma feature entra sem número.** Antes e depois: falso positivo, recall, latência.
6. **Honestidade acima de demo.** Se algo é fictício, o README diz que é; se está incompleto, o
   `doctor` avisa.

---

## 3. Métricas de sucesso (north star)

Estas são as metas que ordenam o roadmap. Todas medidas pelo `gl bench` (ver M1) sobre um corpus
versionado — nunca "no olho".

| Métrica | Baseline hoje | Meta M1 | Meta M3 | Como medir |
| --- | --- | --- | --- | --- |
| Falso positivo em nível bloqueante (`critical`/`high`) | desconhecido | ≤ 2% | ≤ 1% | corpus rotulado |
| Falso positivo em qualquer nível | desconhecido | ≤ 10% | ≤ 6% | corpus rotulado |
| Recall no conjunto "tem que pegar" | desconhecido | ≥ 95% | ≥ 98% | corpus rotulado |
| Latência p50, diff de 500 linhas | ~30 ms¹ | ≤ 60 ms | ≤ 60 ms | `gl bench` |
| Latência p95, diff de 2 000 linhas | ~180 ms² | ≤ 500 ms | ≤ 400 ms | `gl bench` |
| Cobertura de contrato (endpoints, flags, eventos) | ~90% | 100% | 100% | auditoria da matriz em SPECS §15 |
| Dependências de runtime | 0 | 0 | 0 | `npm ls --prod` |

¹,² estimativas do motor atual em diffs pequenos/médios; a primeira tarefa do M1 é transformar isso
em número medido.

---

## 4. Roadmap por ondas

Cada onda é entregável de ponta a ponta (código + testes + docs + números). "1 sprint" ≈ uma semana
de trabalho focado de uma pessoa.

| Onda | Objetivo | Esforço | Depende de | Status |
| --- | --- | --- | --- | --- |
| **M0** | Fundação: motor, LLM, CLI, HTTP/SSE, GitHub App, painel | — | — | ✅ concluída (v1.0.0) |
| **M1** | Precisão medida: corpus rotulado + `gl bench` + gate de CI | 1 sprint | M0 | ⏳ próxima |
| **M2** | Análise além da linha: tokenizer, escopo, taint-lite, entropia | 2 sprints | M1 | planejada |
| **M3** | Correção verificável: `gl fix` + validação + testes pós-correção | 1–2 sprints | M1 | planejada |
| **M4** | GitHub App de produção: token cache, comentário único, deploy | 2 sprints | M0 | planejada |
| **M5** | Superfície: GitLab, Slack, webhook genérico | 2 sprints | M4 | planejada |
| **M6** | Memória e times: store persistente, política por repo, auditoria | 2 sprints | M0 | planejada |

**Ordem recomendada:** M1 → M2 → M3 → M4 → M5 → M6. M4 pode rodar em paralelo a M2/M3 se houver
uma segunda pessoa, porque mexe em arquivos diferentes (`agent/github*.js`, `server/github-app`).

---

## 5. Detalhe das ondas

### M0 — Fundação ✅

Entregue e verificado:

- [x] Parser de diff unificado, com hunks, binários, renames e contagem `+/-`.
- [x] 42 regras determinísticas, com severidade, confiança, `why`, `docs` e sugestão.
- [x] Veredito `ready` / `attention` / `blocked`, `failOn` configurável e código de saída.
- [x] Supressões em três camadas: `greenlight-ignore`, exceções do `.greenlight.json`, dispensas.
- [x] Contexto aprendido (`gl sync`): linguagens, framework de teste, convenções, regras da casa.
- [x] LLM opcional (OpenAI, Anthropic, Ollama) com redação de segredos e fallback silencioso.
- [x] CLI `gl` (review, rules, sync, dismiss, last, doctor), `--pr`, `--apply`, `--markdown`.
- [x] Servidor HTTP + SSE sem dependências, rate limit, CSP compatível com a prévia.
- [x] GitHub App: webhook assinado, JWT RS256, comentários com bloco `suggestion`, check run.
- [x] Painel `#agent` na landing, alimentado por SSE real, com aplicação de correção.
- [x] 101 testes e auto-revisão do branch com 0 achados.

### M1 — Precisão medida (1 sprint) · P0

**Problema.** Sem corpus e sem números, qualquer regra nova é fé. O projeto já foi mordido por isso:
um passe de endurecimento eliminou 19 falsos positivos de `SEC002` e 75 avisos de `LNT009`.

**Entregáveis**

- [ ] `bench/corpus/` com ≥ 60 diffs versionados, cada um com rótulo em `bench/corpus/*.json`:
      `expect: none | block | warn` e a lista de `mustCatch` (`ruleId` + arquivo).
      Origem: 4 cenários atuais, 20 trechos de PRs reais de OSS (fixados por commit, licença
      compatível, trecho mínimo), 20 casos sintéticos de cada família de regra, 16 "limpos difíceis"
      (código que *parece* suspeito e não é).
- [ ] `bench/run.js`: roda o motor em cada diff, compara com o rótulo e calcula, por regra e global:
      TP, FP, FN, precisão, recall, F1, tempo. Saída JSON + tabela Markdown.
- [ ] `gl bench [--rule SEC002] [--json] [--update] [--min-precision 0.9]`.
- [ ] Flag `experimental: true` no descritor da regra: regra experimental **não bloqueia**
      (`verdict` a trata como `info`), mas continua aparecendo como observação.
- [ ] `npm run bench` no `package.json`; `bench/latest.md` gerado e commitado a cada mudança de regra.
- [ ] Gate de CI: falha se FP bloqueante > 2%, FP total > 10% ou recall do conjunto "tem que pegar"
      < 95%. Tolerância explícita por regra em `bench/budget.json` para casos conhecidos.
- [ ] Seção "Precisão" no README com a tabela real, incluindo as três piores regras por FP.

**Definition of Done**

- `npm run bench` sai 0 no branch; `bench/latest.md` mostra os números da meta M1.
- Existe pelo menos um teste que falha de propósito se uma regra conhecida regredir
  (`bench` roda dentro de `npm test` em modo rápido, com 5 diffs de fumaça).
- README troca "as regras foram afinadas à mão" por números auditáveis.

**Risco.** O corpus pode virar um espelho do que as regras já pegam (viés de seleção). Mitigação:
os 20 trechos de OSS são escolhidos **antes** de rodar o motor, e o rótulo é escrito à mão.

### M2 — Análise além da linha (2 sprints) · P0

**Problema.** As regras veem `linha.content` e, no máximo, uma janela de ±3 linhas. Isso gera dois
erros simétricos: `BUG001` não entende que o `wait` está três linhas abaixo; `SEC002` não sabe que a
string concatenada veio de `req.query`.

**Entregáveis**

- [ ] `agent/parse/tokenizer.js`: tokenizador incremental para JS/TS (comentários, strings, template
      literals, regex, pontuação), sem dependências, reutilizando `stripStrings` só como atalho.
      Contrato: `tokenize(source) → [{type, value, line, col}]`, tolerante a entrada truncada.
- [ ] `agent/parse/scope.js`: blocos, funções (declaração, arrow, método), imports/exports e
      profundidade de chaves a partir dos tokens — não de regex.
- [ ] `agent/parse/taint.js`: rastreio intra-função de fonte → sink, janela de 5 linhas, 4 famílias:
      `req.*`/`ctx.*`/`event.*` → SQL (`SEC002`), `innerHTML` (`SEC005`), `exec`/`spawn` (`SEC003`),
      `fetch` (`SEC011`). Cada achado carrega o caminho (`source → sink`) em `why`.
- [ ] `agent/parse/entropy.js`: entropia de Shannon + allowlist de placeholders para `SEC001`,
      reduzindo falso positivo em hashes, UUIDs e fixtures.
- [ ] Migrar 8 regras de maior impacto (`SEC001`, `SEC002`, `SEC003`, `SEC005`, `BUG001`, `BUG005`,
      `BUG006`, `TST003`) para o tokenizador, mantendo o id e o fingerprint estáveis.
- [ ] Parser opcional: se `acorn` (JS) ou `typescript` existir em `node_modules`, usar para validação
      de sintaxe e melhor precisão; senão, seguir no tokenizador próprio. Nunca `require` obrigatório.
- [ ] Testes de propriedade: todo achado tem `file`/`line` válidos; nenhum diff malformado (hunk
      truncado, CRLF, BOM, binário, diff vazio) derruba o pipeline.

**Definition of Done**

- `gl bench` mostra FP total ≤ 6% e recall ≥ 98%, sem nenhuma regra acima de 15% de FP.
- 8 regras migradas mantêm os mesmos ids e os fingerprints dos cenários atuais (teste de snapshot).
- Tempo p95 em 2 000 linhas ≤ 400 ms — o tokenizador não pode custar mais que o ganho.

**Risco.** Complexidade sem retorno: um tokenizador meia-boca é pior que regex. Mitigação: cada
família entra atrás do bench e só é ligada se melhorar o número; o código antigo fica ao lado até lá.

### M3 — Correção verificável (1–2 sprints) · P1

**Problema.** "Aplicar correção" hoje só reescreve texto e re-revisa. Se a sugestão quebrar o código,
ninguém percebe — e o teste que roda é o da regra, não o do repositório.

**Entregáveis**

- [ ] `gl fix [diff] [--ids a,b] [--all] [--write] [--test "<comando>"]`: aplica N sugestões em
      ordem, detecta sobreposição de faixas e recusa com mensagem clara.
- [ ] Validação estrutural da sugestão antes de aplicar: delimitadores balanceados na linguagem,
      indentação preservada, nenhum `TODO` deixado para trás.
- [ ] Execução opcional do comando de teste em cópia temporária (`os.tmpdir()`), com timeout de 60 s
      e saída resumida: "antes: 3 falhas · depois: 0 falhas".
- [ ] `agent/patch.js` ganha `applyMany()` com relatório por sugestão (`applied | conflict | skipped`).
- [ ] Seam no GitHub App: comentário de correção menciona "validado por `<comando>`" apenas quando
      a validação realmente rodou.
- [ ] 3 fixtures e2e: retry (verde depois), secret (verde), xss (parcial — 2 de 4 aplicáveis).

**Definition of Done**

- `gl fix samples/retry.diff --test "npm test"` termina com os testes passando no repositório de
  exemplo e relatório legível.
- Nenhuma escrita fora da cópia temporária sem `--write` explícito.

**Risco.** Comando arbitrário do usuário executando em CI. Mitigação: nunca por padrão, nunca em
webhook, sempre com timeout e aviso explícito no `doctor`.

### M4 — GitHub App de produção (2 sprints) · P1

**Problema.** O app funciona contra uma API falsa, mas nunca viu rate limit, token expirado, PR
gigante com 300 arquivos ou um webhook reentregue. E ele cria um comentário por revisão.

**Entregáveis**

- [ ] Cache de token de instalação com expiração (50 min) e renovação transparente; `401` força
      renovação e uma nova tentativa.
- [ ] Respeito a `x-ratelimit-remaining`/`reset`: espera, loga e continua; `403` de rate limit não
      perde a revisão.
- [ ] **Comentário único e atualizável** por PR (sticky): procura a marca `<!-- greenlight:summary -->`
      e edita em vez de criar. Comentários inline não duplicam em `synchronize`.
- [ ] Revisão incremental: em novo push, resolve conversas cujo achado não reproduz mais.
- [ ] Fatiamento de check run: anotações em lotes de 50, respeitando o limite da API.
- [ ] PR grande: acima de 300 arquivos ou 2 MB, revisar em partes e resumir; aviso no comentário.
- [ ] `docs/deploy.md`: systemd, proxy TLS (Caddy e nginx), variáveis, rotação de chave, teste com
      `curl` assinado, checklist de instalação do app.
- [ ] Simulador de GitHub (`test/helpers` ganha `fakeGitHub` com fila de respostas): cobre `429`,
      `502`, token expirado, payload reentregue e PR acima do limite.

**Definition of Done**

- Uma execução real registrada (screenshot/log) revisando um PR de um repositório de teste, com
  check run verde e um único comentário atualizado em dois pushes seguidos.
- `gl doctor` valida chave, app id e secret antes de subir, com mensagens específicas.

**Risco.** Exigir host público/HTTPS. Mitigação: documentar também o modo `gl review --pr` com
`GITHUB_TOKEN` como caminho sem servidor.

### M5 — Superfície: GitLab, Slack, webhook genérico (2 sprints) · P1

**Problema.** A landing promete GitLab e Slack. Hoje é copy.

**Entregáveis**

- [ ] `agent/integrations/` com interface única: `verify(request)`, `parse(request)`,
      `publish(review, target)`. GitHub App vira a primeira implementação, sem mudar comportamento.
- [ ] GitLab: webhook `Merge Request Hook` (secret token), `POST /api/v4/projects/:id/merge_requests/:iid/discussions`
      com `position` para comentário inline, commit status `success`/`failed`.
- [ ] Slack: digest por revisão em canal configurado (`SLACK_WEBHOOK_URL`), 3 achados principais,
      link para o PR; sem spam em `ready`.
- [ ] Webhook genérico (`POST /api/hooks/:name`) com JSON Schema publicado e assinatura HMAC.
- [ ] Página de configuração read-only em `/integrations` mostrando o que está ligado e o que falta.

**Definition of Done**

- Contrato de `Finding` e `Review` idêntico nas três saídas; testes de contrato com servidores falsos.
- Landing sem asterisco em GitLab/Slack; README documenta o que cada integração faz e não faz.

**Risco.** Escopo do GitLab (posições de diff são notoriamente chatas). Mitigação: começar por
comentário de sumário + status; inline só depois de estabilizar o mapeamento de linhas.

### M6 — Memória e times (2 sprints) · P2

**Problema.** A dispensa some quando o servidor reinicia; não há política por repositório nem rastro
de quem aplicou o quê.

**Entregáveis**

- [ ] `agent/store.js`: JSON com escrita atômica (`tmp` + `rename`), lock por arquivo, versão de
      esquema e migração. Substitui a memória em processo do servidor.
- [ ] Política por repo: `.greenlight.json` do repositório tem precedência sobre defaults da org,
      com `extends` local e aviso quando a chave é ignorada.
- [ ] Auditoria em `.greenlight/audit.log` (JSONL): revisão, aplicação, dispensa, autor, data.
- [ ] `gl dismiss --reason` e sincronização opcional de dispensa com o GitHub (resolve conversa).
- [ ] `GET /api/history?repo=&since=` com paginação e `GET /api/audit`.
- [ ] Feedback loop: cada dispensa ajusta a confiança daquela regra **naquele repositório**
      (contagem local, sem treino), exposta em `gl rules --stats`.

**Definition of Done**

- Reiniciar o servidor mantém dispensas e histórico; teste de migração de esquema antigo → novo.
- Duas instâncias concorrentes não corrompem o arquivo (teste com dois processos).

---

## 6. Backlog priorizado (fora das ondas)

### P1 — alto valor, baixo custo

| Item | Por quê | Esforço |
| --- | --- | --- |
| Export SARIF 2.1.0 (`gl review --sarif`) | Entra no code scanning do GitHub de graça | 2 dias |
| GitHub Action oficial (`action.yml`) | Instalação sem hospedar servidor | 2 dias |
| Hook de pre-commit (`gl review --staged`) | Feedback antes do push, não depois | 2 dias |
| HTML report autocontido (`--report-html`) | Compartilhar revisão sem servidor | 2 dias |
| `--changed-only` com cache por hash de arquivo | Monorepo grande sem reprocessar tudo | 3 dias |
| Tradução das mensagens para `en` (`GREENLIGHT_LANG`) | Uso fora do Brasil | 3 dias |

### P2 — depende de demanda

- Extensão de VS Code: diagnósticos por `gl review --json` num `DiagnosticCollection`.
- Revisão por arquivo salvo (watch mode) para o loop local.
- Suporte a `.greenlight.yaml` (mesmo esquema, parser YAML mínimo).
- Relatório JUnit XML para pipelines legados.
- Comparação de duas revisões (`gl diff rv_a rv_b`) para medir tendência.

### Fora de escopo (decidido, não reabrir sem pedido explícito)

- **Substituir linter/formatter.** O Greenlight revisa o *diff*; Ruff/ESLint continuam sendo donos
  do estilo fino. Duplicar isso é a receita para ruído.
- **Modelo próprio / treino.** A camada LLM é API de terceiro, opcional, com redação.
- **Auto-merge.** O agente recomenda; quem faz merge é humano (ou uma política de branch externa).
- **Preços, uptime, depoimentos.** Continuam fictícios no exercício de landing; não viram feature.
- **Reescrever a landing em framework.** Ela é HTML/CSS/JS sem build de propósito.

---

## 7. Riscos e mitigação

| Risco | Impacto | Probabilidade | Mitigação |
| --- | --- | --- | --- |
| Regras léxicas empacam em ~70% de recall | Alto | Média | M2 atrás do bench; medir antes/depois por família |
| Falso positivo corrói confiança | Alto | Média | Gate de CI (M1), `experimental`, dispensa com motivo |
| LLM instável/caro/indisponível | Médio | Alta | Nunca bloqueia; redação; timeout; fallback total |
| Webhook exige host público | Médio | Certa | Modo `--pr` como caminho sem servidor (M4) |
| Zero deps limita parsing | Médio | Alta | Dependências opcionais com fallback; nunca `require` obrigatório |
| Push protection do GitHub (GH013) | Médio | Baixa | Fixtures de segredo montadas em runtime; nunca literal no histórico |
| Crescer escopo e quebrar o painel | Médio | Média | Contrato de UI em SPECS §12 + smoke jsdom no CI |
| Perda de dados do store JSON | Médio | Baixa | Escrita atômica + backup `.bak` + teste de concorrência |

---

## 8. Sequência sugerida (três semanas)

**Semana 1 — confiança.** M1 inteiro: corpus, `gl bench`, gate, tabela no README. Nenhuma regra nova.
**Semana 2 — profundidade.** M2: tokenizador, escopo, taint-lite; migrar as 8 regras; medir.
**Semana 3 — entrega.** M3 (`gl fix` + validação) e o começo de M4 (token cache + comentário único).

Ao fim da semana 3 o projeto tem: número de precisão publicável, 8 regras estruturais, correção
verificada por teste e um app que não duplica comentário. É o ponto em que dá para convidar alguém
de fora para instalar sem vergonha.

---

## 9. Definition of Done global

Uma entrega só conta como pronta quando **todos** os itens valem:

- [ ] `npm test` verde, com teste novo cobrindo o caminho feliz **e** o de erro.
- [ ] `npm run bench` verde, e `bench/latest.md` regenerado se alguma regra mudou.
- [ ] Auto-revisão do branch (`gl review <diff>`) sem achados bloqueantes; exceções declaradas com motivo.
- [ ] `README.md` e `SPECS.md` atualizados no mesmo commit (contrato mudou? spec mudou).
- [ ] `gl doctor` continua apontando o que falta, sem inventar estado.
- [ ] Nenhuma dependência nova de runtime.
- [ ] Sem segredo literal, sem `innerHTML` com dado de servidor, sem `eval`.
- [ ] `CHANGELOG.md`/nota do PR explica o efeito para quem usa.

---

## 10. Decisões que dependem de você

1. **Precisão ou cobertura?** O plano assume precisão primeiro (M1/M2 antes de M5). Se a prioridade
   comercial for "GitLab e Slack existem", invertemos M5 com M2 — mas o ruído continua sem número.
2. **Hospedar o GitHub App?** Sem host público, M4 entrega só o modo `gl review --pr` e o deploy fica
   documentado, não rodando. Preciso de um destino (Fly/Render/VPS) para fechar a DoD.
3. **Chave de LLM?** Sem chave, tudo funciona e o painel mostra "LLM: off". Para validar a camada
   semântica de verdade, uma chave de teste (OpenAI ou Anthropic) destrava M2/M3 com mais sinal.
4. **Zero dependências é linha vermelha?** Se `acorn`/`typescript` como dependência opcional já vale,
   M2 fica ~30% mais barato e mais preciso. Se não, seguimos com tokenizador próprio.
5. **Qual integração primeiro: GitLab ou Slack?** Slack é um dia de trabalho; GitLab é uma sprint.

Enquanto essas decisões não voltam, o caminho seguro é **M1**: ele não depende de nenhuma delas e
melhora tudo que vem depois.
