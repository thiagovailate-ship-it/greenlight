'use strict';

const {
  infoSuggestion,
  replaceSuggestion,
  stripStrings,
  stripRegexLiterals,
  indentOf,
  findBraceBlockEnd,
  findIndentBlockEnd,
  truncate,
} = require('./util');

const LOOSE_EQUALITY = /(?<![=!<>])(?:==|!=)(?![=])/; // greenlight-ignore BUG003

function loopVariable(content) {
  const match = /\b(?:for|while)\s*\(\s*(?:let|var|const)\s+([A-Za-z_$][\w$]*)/.exec(content);
  return match ? match[1] : null;
}

function catchVariable(block) {
  for (const line of block) {
    const match = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line.content);
    if (match) return match[1];
  }
  return null;
}

module.exports = [
  {
    id: 'BUG001',
    title: 'Retry sem backoff',
    severity: 'medium',
    category: 'bug',
    description: 'Loop de retry com espera fixa ou sem espera entre tentativas.',
    languages: ['js', 'ts', 'py', 'go', 'java', 'kotlin', 'rust', 'csharp', 'php', 'swift'],
    run({ content, file, lines, index }) {
      const loop = /^\s*(?:for|while|do)\b/.test(content) &&
        /\b(?:retry|retries|attempt|attempts|maxAttempts|MAX_RETRIES|maxRetries)\b/i.test(content);
      if (!loop) return [];

      const indented = ['py', 'rb'].includes(file.language);
      const endIndex = indented ? findIndentBlockEnd(lines, index) : findBraceBlockEnd(lines, index);
      if (endIndex <= index) return [];

      const block = lines.slice(index, endIndex + 1);
      const hasCatch = block.some((line) => /\bcatch\b|\bexcept\b/.test(line.content));
      if (!hasCatch) return [];

      const delayLine = block.find((line) =>
        /\b(?:wait|sleep|delay|setTimeout|time\.sleep|Thread\.sleep|after)\s*\(/i.test(line.content),
      );
      const hasBackoff = block.some((line) =>
        /(?:\*\s*2\s*\*\*|\*\*\s*[A-Za-z_$]|Math\.pow\s*\(\s*2|<<\s*[A-Za-z_$]|jitter|exponential)/i.test(
          line.content,
        ),
      );
      if (hasBackoff) return [];

      const allAdded = block.every((line) => line.type === 'add');
      const variable = loopVariable(content) || 'i';
      const limit = /<\s*([A-Za-z_$][\w$.]*)\s*;/.exec(content)?.[1] || 'attempts';
      const errorName = catchVariable(block);

      let suggestion;
      if (delayLine && allAdded && (file.language === 'ts' || file.language === 'js')) {
        const originalIndent = indentOf(delayLine.content);
        const call = delayLine.content.trim();
        const waitArg = /\(([^)]*)\)/.exec(call)?.[1] || 'DELAY';
        const newDelay = call.replace(`(${waitArg})`, `(${waitArg} * 2 ** ${variable} + Math.random() * ${waitArg})`);
        const guard = errorName
          ? `if (${variable} === ${limit} - 1) throw ${errorName}`
          : `if (${variable} === ${limit} - 1) throw new Error('retry esgotado')`;
        const replacement = block
          .map((line) => {
            if (line === delayLine) return `${originalIndent}${guard}\n${originalIndent}${newDelay}`;
            return line.content;
          })
          .join('\n');
        suggestion = replaceSuggestion(
          'Adicionar backoff exponencial com jitter',
          'typescript',
          replacement,
          lines[index].newLine,
          lines[endIndex].newLine,
        );
      } else {
        const code =
          'for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {\n' +
          '  try {\n' +
          '    return await task()\n' +
          '  } catch (error) {\n' +
          '    if (attempt === MAX_ATTEMPTS - 1) throw error\n' +
          '    const backoff = BASE_DELAY * 2 ** attempt + Math.random() * BASE_DELAY\n' +
          '    await wait(backoff)\n' +
          '  }\n' +
          '}';
        suggestion = infoSuggestion('Usar backoff exponencial com jitter', 'javascript', code);
      }

      return [
        {
          severity: delayLine ? 'medium' : 'high',
          message: delayLine
            ? 'Retry com espera fixa entre tentativas — sem backoff exponencial.'
            : 'Retry imediato, sem espera entre tentativas.',
          why: 'Sob falha contínua, retentar no mesmo ritmo martela o serviço e piora o incidente.',
          code: truncate(content),
          suggestion,
        },
      ];
    },
  },
  {
    id: 'BUG002',
    title: 'Erro engolido',
    severity: 'medium',
    category: 'bug',
    description: 'catch/except vazio ou que descarta o erro.',
    languages: ['js', 'ts', 'py', 'java', 'php', 'ruby', 'csharp', 'go'],
    run({ content, file, lines, index }) {
      const code = stripStrings(content);
      const sameLine = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(code) ||
        /\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*\{\s*\}\s*\)/.test(content) ||
        /^\s*except(?:\s+[^:]+)?\s*:\s*pass\s*$/.test(content);
      if (!sameLine) {
        const opensCatch = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(code) ||
          /^\s*except(?:\s+[^:]+)?\s*:\s*$/.test(code);
        if (!opensCatch) return [];
        if (['py', 'rb'].includes(file.language)) {
          const endIndex = findIndentBlockEnd(lines, index);
          const body = lines
            .slice(index + 1, endIndex + 1)
            .filter((line) => line.content.trim() && !/^(?:pass|\.\.\.|;)$/.test(line.content.trim()));
          if (body.length > 0) return [];
        } else {
          const endIndex = findBraceBlockEnd(lines, index);
          const body = lines.slice(index + 1, endIndex).filter((line) => line.content.trim());
          if (body.length > 0) return [];
        }
      }
      return [
        {
          severity: 'medium',
          message: 'Erro capturado e descartado sem log nem tratamento.',
          why: 'A falha some do radar: o chamador segue como se tivesse dado certo.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Registrar e propagar (ou tratar de fato)',
            'javascript',
            'try {\n  await deliver(event)\n} catch (error) {\n' +
              "  logger.error({ err: error }, 'falha ao entregar evento')\n  throw error\n}",
          ),
        },
      ];
    },
  },
  {
    id: 'BUG003',
    title: 'Igualdade frouxa',
    severity: 'low',
    category: 'bug',
    description: 'Uso de ==/!= em vez de ===/!==.',
    languages: ['js', 'ts'],
    run({ content }) {
      const bare = stripRegexLiterals(stripStrings(content));
      // == null / != null são aceitos: cobrem null e undefined de propósito.
      const withoutNullChecks = bare.replace(/[!=]==?\s*null\b/g, '');
      if (!LOOSE_EQUALITY.test(withoutNullChecks)) return [];
      return [
        {
          severity: 'low',
          message: 'Comparação com coerção implícita de tipos.',
          why: '== converte os operandos; 0 == "" e [] == false são armadilhas clássicas.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Usar igualdade estrita',
            'javascript',
            content.replace(/(?<![=!<>])==(?![=])/g, '===').replace(/(?<![=!<>])!=(?![=])/g, '!=='),
          ),
        },
      ];
    },
  },
  {
    id: 'BUG004',
    title: 'parseInt sem base',
    severity: 'low',
    category: 'bug',
    description: 'parseInt chamado sem o parâmetro radix.',
    languages: ['js', 'ts'],
    run({ content, line }) {
      if (!/\bparseInt\s*\(\s*[^,()]+\s*\)/.test(stripStrings(content))) return [];
      const match = /\bparseInt\s*\(\s*([^,()]+)\s*\)/.exec(content);
      if (!match) return [];
      const replacement = content.replace(match[0], `parseInt(${match[1].trim()}, 10)`);
      return [
        {
          severity: 'low',
          message: 'parseInt sem base explícita.',
          why: 'Sem o radix, "08" pode ser lido como octal em runtimes antigos e a intenção fica implícita.',
          code: truncate(content),
          suggestion: replaceSuggestion('Informar o radix', 'javascript', replacement, line.newLine, line.newLine),
        },
      ];
    },
  },
  {
    id: 'BUG005',
    title: 'Promise não aguardada',
    severity: 'medium',
    category: 'bug',
    description: 'Resultado de chamada assíncrona atribuído sem await.',
    languages: ['js', 'ts'],
    run({ content }) {
      if (/\bawait\b|\.then\s*\(/.test(content)) return [];
      const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:fetch|axios(?:\.\w+)?|got|request)\s*\(/.exec(
        content,
      );
      if (!match) return [];
      return [
        {
          severity: 'medium',
          confidence: 0.65,
          message: `"${match[1]}" recebe uma Promise, não a resposta.`,
          why: 'Sem await, o código segue antes da requisição terminar e erros viram rejeições soltas.',
          code: truncate(content),
          suggestion: infoSuggestion('Aguardar a promise', 'javascript', content.replace(/=\s*/, '= await ')),
        },
      ];
    },
  },
  {
    id: 'BUG006',
    title: 'Callback assíncrono em forEach',
    severity: 'medium',
    category: 'bug',
    description: 'forEach com callback async não espera as promises.',
    languages: ['js', 'ts'],
    run({ content, line }) {
      if (!/\.forEach\s*\(\s*async\b/.test(stripStrings(content))) return [];
      return [
        {
          severity: 'medium',
          message: 'forEach com callback async não aguarda as operações.',
          why: 'forEach ignora as promises; a função externa resolve antes de todas terminarem.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Trocar por for…of ou Promise.all',
            'javascript',
            'for (const item of items) {\n  await processar(item)\n}\n\n' +
              '// Em paralelo, quando a ordem não importa:\n' +
              'await Promise.all(items.map((item) => processar(item)))',
          ),
        },
      ];
    },
  },
  {
    id: 'BUG007',
    title: 'Limite de array off-by-one',
    severity: 'medium',
    category: 'bug',
    description: 'Comparação <=/> = com .length.',
    languages: ['js', 'ts', 'java', 'csharp', 'php'],
    run({ content }) {
      const match = /(<=|>=)\s*([A-Za-z_$][\w$.[\]]*)\.length\b/.exec(content);
      if (!match) return [];
      return [
        {
          severity: 'medium',
          confidence: 0.7,
          message: 'Índice pode alcançar `.length` (fora do array).',
          why: 'O último índice válido é length - 1; <= length causa acesso undefined/out-of-bounds.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Usar o limite exclusivo',
            'javascript',
            content.replace(/<=\s*([\w$.[\]]+)\.length/, '< $1.length'),
          ),
        },
      ];
    },
  },
  {
    id: 'BUG008',
    title: 'setTimeout com string',
    severity: 'medium',
    category: 'bug',
    description: 'Código passado como string para setTimeout.',
    languages: ['js', 'ts'],
    run({ content }) {
      if (!/setTimeout\s*\(\s*['"`]/.test(content)) return [];
      return [
        {
          severity: 'medium',
          message: 'setTimeout recebendo código como string.',
          why: 'Além de lento, avaliar string executa código com implicações de segurança.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Passar uma função',
            'javascript',
            "setTimeout(() => executarTarefa(), 500)",
          ),
        },
      ];
    },
  },
  {
    id: 'BUG009',
    title: 'Executor async em Promise',
    severity: 'medium',
    category: 'bug',
    description: 'new Promise com executor async.',
    languages: ['js', 'ts'],
    run({ content }) {
      if (!/new\s+Promise\s*\(\s*async\b/.test(stripStrings(content))) return [];
      return [
        {
          severity: 'medium',
          message: 'new Promise com executor async.',
          why: 'Um throw dentro do executor async vira rejeição não tratada da promise externa.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Não marcar o executor como async',
            'javascript',
            'return new Promise((resolve, reject) => {\n' +
              '  tarefaAssincrona().then(resolve, reject)\n' +
              '})',
          ),
        },
      ];
    },
  },
];
