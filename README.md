# Greenlight — landing page (HTML/CSS/JS, sem build)

Landing page do **Greenlight** — ferramenta fictícia de revisão de código com IA para
pull requests — reescrita em HTML, CSS e JavaScript.

## Estrutura

```
greenlight-vanilla/
  index.html    todo o conteúdo e os ícones SVG inline — nada é gerado em runtime
  styles.css    tokens, base, componentes, breakpoints e preferências do usuário
  main.js       só comportamento: menu, sequência do diff, count-ups, reveals
```

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
