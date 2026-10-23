'use strict';

const { infoSuggestion, replaceSuggestion, stripStrings, truncate } = require('./util');

const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b/; // greenlight-ignore LNT003
const TS_SUPPRESS = /@ts-(?:ignore|expect-error|nocheck)\b/; // greenlight-ignore LNT004
const ESLINT_DISABLE = /eslint-disable(?:-next-line|-line)?/; // greenlight-ignore LNT008
const BARE_EXCEPT = /^\s*except(?:\s+[^:]+)?\s*:\s*$/; // greenlight-ignore LNT010
const ALERT = /\balert\s*\(/;
const VAR_DECL = /^\s*var\s+/;

module.exports = [
  {
    id: 'LNT001',
    title: 'console.log esquecido',
    severity: 'low',
    category: 'quality',
    description: 'Log de depuração deixado no código.',
    languages: ['js', 'ts', 'jsx', 'tsx'],
    run({ content, file, line }) {
      // Só conta quando é uma chamada de verdade: no começo da linha ou depois
      // de `;`/`{` — não quando o texto aparece numa regex ou string.
      if (!/(?:^|[;{])\s*console\.(?:log|debug)\s*\(/.test(stripStrings(content))) return [];
      if (file.isTest) return [];
      const isWholeStatement = /^\s*console\.(?:log|debug)\s*\(/.test(content);
      const code = isWholeStatement ? content.replace(/^\s*console\.(?:log|debug)\s*\([\s\S]*\)\s*;?\s*$/, '') : null;
      return [
        {
          severity: 'low',
          message: 'Log de depuração no código de produção.',
          why: 'Além de ruído nos logs, a linha pode vazar dados do contexto.',
          code: truncate(content),
          suggestion:
            code !== null
              ? replaceSuggestion('Remover a linha', 'javascript', '', line.newLine, line.newLine)
              : infoSuggestion('Remover a linha', 'text', 'Remova o log ou troque por um logger estruturado com nível.'),
        },
      ];
    },
  },
  {
    id: 'LNT002',
    title: 'debugger no código',
    severity: 'medium',
    category: 'quality',
    description: 'Pausa de depuração esquecida.',
    languages: ['js', 'ts'],
    run({ content, line }) {
      if (!/^\s*debugger\s*;?\s*$/.test(stripStrings(content))) return [];
      return [
        {
          severity: 'medium',
          message: 'Comando debugger esquecido no código.',
          why: 'Em produção, a execução fica presa se o devtools estiver aberto.',
          code: truncate(content),
          suggestion: replaceSuggestion('Remover a linha', 'javascript', '', line.newLine, line.newLine),
        },
      ];
    },
  },
  {
    id: 'LNT003',
    title: 'TODO ou FIXME',
    severity: 'info',
    category: 'quality',
    description: 'Pendência anotada no diff.',
    languages: null,
    skipComments: false,
    commentsOnly: true,
    run({ content }) {
      if (!TODO.test(content)) return [];
      return [
        {
          severity: 'info',
          message: 'Pendência marcada no código.',
          why: 'TODOs sem dono e sem issue tendem a envelhecer sem serem resolvidos.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Transformar em issue',
            'text',
            'Abra uma issue com o contexto e referencie o número aqui.',
          ),
        },
      ];
    },
  },
  {
    id: 'LNT004',
    title: 'Supressão de tipos',
    severity: 'low',
    category: 'quality',
    description: '@/ts-ignore ou @ts-expect-error.',
    languages: ['ts'],
    run({ content }) {
      if (!TS_SUPPRESS.test(content)) return [];
      const isNoCheck = /@ts-nocheck/.test(content);
      return [
        {
          severity: isNoCheck ? 'medium' : 'low',
          message: isNoCheck ? '@ts-nocheck desliga o TypeScript no arquivo.' : 'Erro de TypeScript suprimido.',
          why: 'A supressão esconde a incompatibilidade em vez de resolvê-la.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Corrigir o tipo',
            'typescript',
            'Modelar o tipo com unknown + narrowing ou declarar a interface esperada.',
          ),
        },
      ];
    },
  },
  {
    id: 'LNT005',
    title: 'Uso de any',
    severity: 'low',
    category: 'quality',
    description: 'Tipo any em TypeScript.',
    languages: ['ts'],
    run({ content }) {
      if (!/(?::\s*any\b|\bas\s+any\b)/.test(content)) return [];
      return [
        {
          severity: 'low',
          message: 'Tipo `any` desliga a checagem de tipos.',
          why: 'O erro que o compilador pegaria passa a acontecer em runtime.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Preferir unknown + narrowing',
            'typescript',
            'function parse(input: unknown) {\n' +
              '  if (typeof input !== "object" || input === null) throw new TypeError()\n' +
              '  return input as Record<string, unknown>\n}',
          ),
        },
      ];
    },
  },
  {
    id: 'LNT006',
    title: 'Linha longa',
    severity: 'info',
    category: 'quality',
    description: 'Linha acima do limite configurado.',
    languages: ['js', 'ts', 'py', 'go', 'rb', 'php', 'java', 'kotlin', 'rust', 'csharp', 'swift'],
    skipComments: false,
    run({ content, config }) {
      const limit = config.rules.maxLineLength;
      if (!limit || content.length <= limit) return [];
      return [
        {
          severity: 'info',
          message: `Linha com ${content.length} caracteres (limite: ${limit}).`,
          why: 'Linhas longas dificultam a revisão em diffs lado a lado.',
          code: truncate(content),
          suggestion: null,
        },
      ];
    },
  },
  {
    id: 'LNT007',
    title: 'Espaço no fim da linha',
    severity: 'info',
    category: 'quality',
    description: 'Espaços ou tabs no fim da linha.',
    languages: null,
    skipComments: false,
    run({ content, line }) {
      if (!/[ \t]+$/.test(content)) return [];
      const trimmed = content.replace(/[ \t]+$/, '');
      return [
        {
          severity: 'info',
          message: 'Espaço em branco no fim da linha.',
          why: 'Sujeira no diff e conflitos desnecessários no git.',
          code: truncate(content),
          suggestion: replaceSuggestion('Remover o espaço', 'text', trimmed, line.newLine, line.newLine),
        },
      ];
    },
  },
  {
    id: 'LNT008',
    title: 'eslint-disable',
    severity: 'info',
    category: 'quality',
    description: 'Regra de lint desligada no código.',
    languages: ['js', 'ts'],
    commentsOnly: true,
    run({ content }) {
      if (!ESLINT_DISABLE.test(content)) return [];
      return [
        {
          severity: 'info',
          message: 'Regra de ESLint desligada.',
          why: 'Sem justificativa e issue, a supressão vira dívida invisível.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Justificar a exceção',
            'text',
            'Adicione o motivo na mesma linha e abra uma issue para remover a supressão.',
          ),
        },
      ];
    },
  },
  {
    id: 'LNT009',
    title: 'Declaração var',
    severity: 'low',
    category: 'quality',
    description: 'Uso de var em JavaScript.',
    languages: ['js', 'ts'],
    run({ content }) {
      if (!VAR_DECL.test(stripStrings(content))) return [];
      return [
        {
          severity: 'low',
          message: '`var` tem escopo de função e hoisting confuso.',
          why: 'const/let deixam o escopo explícito e evitam redeclarações silenciosas.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Trocar por const ou let',
            'javascript',
            content.replace(/^(\s*)var\s+/, '$1const '),
          ),
        },
      ];
    },
  },
  {
    id: 'LNT010',
    title: 'except sem tipo',
    severity: 'medium',
    category: 'quality',
    description: 'except capturando tudo em Python.',
    languages: ['py'],
    run({ content }) {
      if (!BARE_EXCEPT.test(content)) return [];
      return [
        {
          severity: 'medium',
          message: '`except:` captura até KeyboardInterrupt/SystemExit.',
          why: 'Erros de programação passam despercebidos e o processo não consegue encerrar.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Capturar Exception',
            'python',
            'except Exception as error:\n    logger.exception("falha ao processar")\n    raise',
          ),
        },
      ];
    },
  },
  {
    id: 'LNT011',
    title: 'alert no código',
    severity: 'low',
    category: 'quality',
    description: 'alert() de depuração.',
    languages: ['js', 'ts'],
    run({ content }) {
      if (!ALERT.test(stripStrings(content))) return [];
      return [
        {
          severity: 'low',
          message: 'alert() deixado no código.',
          why: 'Bloqueia a thread e não combina com a interface do produto.',
          code: truncate(content),
          suggestion: infoSuggestion('Usar a UI do produto', 'javascript', 'mostrarToast("Mensagem")'),
        },
      ];
    },
  },
];
