# Greenlight — landing page (HTML/CSS/JS, sem build)

Landing page do **Greenlight** — ferramenta fictícia de revisão de código com IA para
pull requests — reescrita em HTML, CSS e JavaScript puros: sem npm, sem bundler, sem
framework. Basta abrir o `index.html`.

A identidade visual é a mesma da versão React: superfície quase preta, acento
esmeralda, títulos em JetBrains Mono sobre texto em Inter, vidro (glass) em todas as
superfícies.

> Versão React/Vite/Tailwind do mesmo produto: `greenlight-landing/`. Esta pasta é a
> versão estática e em português (pt-BR).

## Como abrir

- **Duplo clique** em `index.html` — funciona direto pelo sistema de arquivos
  (`file://`), porque os scripts são clássicos (`<script src>`), não módulos ES.
- Ou sirva a pasta, se preferir HTTP:

  ```bash
  npx serve .          # ou
  python -m http.server 5174
  ```

- As fontes (Inter e JetBrains Mono) vêm do Google Fonts. Sem rede, o layout se
  mantém com as fontes de fallback do sistema.

## Estrutura

```
greenlight-vanilla/
  index.html    todo o conteúdo e os ícones SVG inline — nada é gerado em runtime
  styles.css    tokens, base, componentes, breakpoints e preferências do usuário
  main.js       só comportamento: menu, sequência do diff, count-ups, reveals
```

## Onde editar o texto

**Todo o texto está no próprio `index.html`.** Diferente da versão React (que
centraliza a cópia em `src/content.js`), aqui cada seção é um bloco comentado
(`<!-- ====== Hero ====== -->`, `<!-- ====== Pricing ====== -->`, …) — edite
diretamente ali. Nada de texto visível vive no CSS.

A única exceção são os rótulos que o JS troca ao final da sequência da demo:
`Checagens em andamento` → `Pronto para o merge`, além de `Abrir menu` / `Fechar
menu`. Os três estão em `main.js` e replicados no HTML no estado inicial.

## O que o JavaScript faz

1. **Menu mobile** — liga/desliga via `aria-expanded` + `aria-controls`, fecha no
   `Escape` (devolvendo o foco ao botão) e ao clicar em qualquer link.
2. **Demo de diff** — quando o painel entra na tela: as 12 linhas entram
   escalonadas (60 ms cada), depois o comentário, depois as 3 checagens uma a uma e,
   por fim, o chip vira "Pronto para o merge" com um pulso de escala. O botão
   *"Ver uma revisão de PR"* reinicia a sequência do zero.
3. **Count-ups** — `1.2M`, `42k`, `<30s`, `99.9%` contam de 0 até o valor com
   `easeOutCubic` em 1,4 s, quando a faixa de estatísticas aparece.
4. **Reveals no scroll** — o que entra na tela aparece com fade + subida de 24px
   (`IntersectionObserver`, uma vez por elemento, escalonado em 80 ms nos grids).

**Sem JavaScript:** todo o conteúdo continua visível (o estado "escondido" dos
reveals só existe sob a classe `js`, adicionada por um script inline no `<head>`) e o
painel do diff aparece direto no estado final.

## Acessibilidade

- Skip link para `#main`; landmarks `header > nav`, `main`, `footer`.
- Menu e controles expõem `aria-expanded` / `aria-controls` e fecham no `Escape`.
- Foco visível em todo elemento interativo (contorno esmeralda com offset).
- `prefers-reduced-motion: reduce` → nenhuma animação: a demo é montada completa no
  primeiro paint, os números já vêm no valor final e o botão de replay não existe.
- `prefers-reduced-transparency: reduce` → o vidro vira um fundo opaco.
- Piso de contraste: `zinc-400` para texto secundário (≥ 4.5:1); nada mais escuro é
  usado sobre este fundo.

## Desempenho

Cerca de **86 KB no total, ≈ 15 KB em gzip** (7,6 KB de HTML + 5,2 KB de CSS +
2,3 KB de JS) — sem runtime de framework e sem bundler. Os 17 ícones do lucide e as
4 marcas (GitHub, GitLab, Slack, LinkedIn) são SVG inline, sem requisições extras.
As animações usam apenas `transform` e `opacity`.

## Diferenças em relação à versão React

- Mesma marcação visual e os mesmos valores de design (tokens, espaçamentos,
  breakpoints em 640 / 768 / 1024 px).
- O preço do plano usa `clamp()`: como o texto em pt-BR é mais longo
  ("Personalizado", "$19/dev/mês"), o tamanho se adapta para não estourar a largura
  dos cards de 3 colunas entre 768 px e 1024 px.
- O conteúdo está em português (a versão React segue em inglês).
