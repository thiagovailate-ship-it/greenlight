'use strict';

const {
  isCommentLine,
  infoSuggestion,
  stripStrings,
  isInsideStringLiteral,
  truncate,
} = require('./util');

const SECRET_PATTERNS = [
  {
    kind: 'chave privada',
    severity: 'critical',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    env: 'PRIVATE_KEY',
  },
  {
    kind: 'token da AWS',
    severity: 'critical',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    env: 'AWS_ACCESS_KEY_ID',
  },
  {
    kind: 'token do GitHub',
    severity: 'critical',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
    env: 'GITHUB_TOKEN',
  },
  {
    kind: 'token do Slack',
    severity: 'critical',
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    env: 'SLACK_TOKEN',
  },
  {
    kind: 'chave do Stripe',
    severity: 'critical',
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/,
    env: 'STRIPE_SECRET_KEY',
  },
  {
    kind: 'chave do Google',
    severity: 'critical',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    env: 'GOOGLE_API_KEY',
  },
  {
    kind: 'token JWT',
    severity: 'high',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    env: 'JWT_TOKEN',
  },
];

const SECRET_KEY = /(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret)/i;
const ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][\w$]*(?:[_-][A-Za-z0-9_$]+)*)\s*(?::\s*[A-Za-z_$][\w$.[\]<>| ]*)?[:=]\s*(['"`])([^'"`\n]{8,})\2/g;
const PLACEHOLDER = new RegExp(
  '^(?:change[_-]?me|example|sample|dummy|test\\w*|secret|password|passwd|todo|fixme|' +
    'x{3,}|\\*+|null|undefined|none|placeholder|your[_-].*)$',
  'i',
);

function envNameFor(variable) {
  return variable
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function envSuggestion(variable, language, envName) {
  const env = envName || envNameFor(variable || 'secret');
  if (language === 'py') {
    return infoSuggestion(
      'Mover o segredo para o ambiente',
      'python',
      `import os\n\n${variable || 'secret'} = os.environ["${env}"]  # nunca faça commit do valor`,
    );
  }
  if (language === 'js' || language === 'ts') {
    return infoSuggestion(
      'Mover o segredo para o ambiente',
      'javascript',
      `// .env (fora do git)\n${env}=...\n\n// código\nconst ${variable || 'secret'} = process.env.${env}\n` +
        `if (!${variable || 'secret'}) throw new Error('${env} não configurada')`,
    );
  }
  return infoSuggestion(
    'Mover o segredo para o ambiente',
    'text',
    `Leia ${env} do ambiente (ou de um cofre de segredos) e remova o valor do código.\n` +
      'Se o valor já foi commitado, rotacione a credencial: o histórico do git mantém tudo.',
  );
}

function isLiteralOnly(rhs) {
  return /^(['"])(?:\\.|(?!\1).)*\1\s*;?$/.test(String(rhs || '').trim());
}

function isObviousNonSecret(value) {
  const v = String(value || '').trim();
  if (/^https?:\/\//i.test(v)) return true;
  if (/^(?:application|text|image|multipart|font)\//i.test(v)) return true;
  if (/^(?:true|false|\d+)$/i.test(v)) return true;
  if (value.includes('${') || value.includes('{{') || value.includes('%s')) return true;
  return false;
}

module.exports = [
  {
    id: 'SEC001',
    title: 'Segredo hardcoded',
    severity: 'critical',
    category: 'security',
    description: 'Detecta chaves, tokens e senhas literais no código.',
    languages: ['js', 'ts', 'py', 'go', 'rb', 'php', 'java', 'kotlin', 'rust', 'csharp', 'shell', 'yaml', 'json', 'terraform'],
    run({ content, file }) {
      const results = [];
      for (const pattern of SECRET_PATTERNS) {
        if (!pattern.re.test(content)) continue;
        results.push({
          severity: pattern.severity,
          message: `Possível ${pattern.kind} hardcoded neste arquivo.`,
          why: 'Segredos no repositório vazam no histórico do git, em forks e em logs de CI.',
          code: truncate(content),
          suggestion: envSuggestion('secret', file.language, pattern.env),
        });
      }
      if (results.length > 0) return results;

      ASSIGNMENT.lastIndex = 0;
      let match = ASSIGNMENT.exec(content);
      while (match) {
        const variable = match[1];
        const value = match[3];
        if (SECRET_KEY.test(variable) && !PLACEHOLDER.test(value) && !isObviousNonSecret(value)) {
          if (file.language === 'json' || file.language === 'yaml') {
            results.push({
              severity: 'high',
              message: `Possível segredo hardcoded em "${variable}".`,
              code: truncate(content),
              suggestion: envSuggestion(variable, file.language),
            });
            match = ASSIGNMENT.exec(content);
            continue;
          }
          results.push({
            severity: 'high',
            message: `Possível segredo hardcoded em "${variable}".`,
            why: 'Uma credencial literal não pode ser rotacionada sem alterar o código.',
            code: truncate(content),
            suggestion: envSuggestion(variable, file.language),
          });
        }
        match = ASSIGNMENT.exec(content);
      }
      return results;
    },
  },
  {
    id: 'SEC002',
    title: 'Injeção de SQL',
    severity: 'high',
    category: 'security',
    description: 'Consulta SQL montada por concatenação ou interpolação de entrada.',
    languages: ['js', 'ts', 'py', 'php', 'java', 'ruby', 'go', 'csharp'],
    run({ content, file }) {
      if (isCommentLine(content, file.language)) return [];
      // Exige forma de SQL, não só a palavra: `.replace(`/`.update(` não contam.
      const SQL = /(?:\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+[\w."`[\]]+\s+SET\b|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b)/i;
      const literal = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
      let match;
      let injected = false;

      while ((match = literal.exec(content))) {
        const quote = match[1];
        const body = match[2];
        if (!SQL.test(body)) continue;
        const before = content.slice(0, match.index);
        const after = content.slice(match.index + match[0].length);
        const isFString = quote !== '`' && /(^|[^\w])f$/i.test(before);
        if (quote === '`' && /\$\{[^}]*\}/.test(body)) injected = true;
        else if (isFString && /\{[^}]*\}/.test(body)) injected = true;
        else if (/^\s*\+/.test(after)) injected = true;
        else if (/\+\s*$/.test(before)) injected = true;
        else if (/^\s*%/.test(after)) injected = true;
        else if (/^\s*\.\s*format\s*\(/.test(after)) injected = true;
      }

      if (!injected) return [];
      return [
        {
          severity: 'high',
          message: 'Consulta SQL montada com dados variáveis — a entrada pode virar comando.',
          why: 'Interpolar ou concatenar entrada em SQL é a definição de injeção de SQL.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Usar consulta parametrizada',
            'javascript',
            'const rows = await db.query(\n' +
              "  'SELECT * FROM customers WHERE email = $1',\n" +
              '  [req.body.email],\n' +
              ')\n\n// MySQL usa ? como marcador. Nunca monte a string SQL com a entrada.',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC003',
    title: 'Injeção de comando',
    severity: 'high',
    category: 'security',
    description: 'Chamada de shell com entrada dinâmica.',
    languages: ['js', 'ts', 'py', 'rb', 'go', 'java'],
    run({ content }) {
      const js = /\b(?:exec|execSync)\s*\([^)]*(?:\$\{|\+\s*[A-Za-z_$])/.test(content);
      const py = /(?:os\.system|subprocess\.(?:run|call|check_output|Popen))\s*\([^)]*(?:shell\s*=\s*True|f['"])/.test(
        content,
      );
      const java = /Runtime\.getRuntime\(\)\.exec\s*\([^)]*\+/.test(content);
      if (!js && !py && !java) return [];
      return [
        {
          severity: 'high',
          message: 'Comando de shell construído com entrada variável.',
          why: 'Metacaracteres de shell (`;`, `|`, `$()`) permitem executar comandos arbitrários.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Executar sem shell, com argumentos',
            'javascript',
            "const { execFile } = require('node:child_process')\n\n" +
              "execFile('git', ['log', '--oneline', branch], (error, stdout) => {\n" +
              '  if (error) throw error\n' +
              '  console.info(stdout)\n' +
              '})',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC004',
    title: 'Execução dinâmica de código',
    severity: 'high',
    category: 'security',
    description: 'Uso de eval ou Function com dados dinâmicos.',
    languages: ['js', 'ts'],
    run({ content }) {
      const bare = stripStrings(content);
      const evalMatch = /\beval\s*\(/.exec(bare);
      const evalCall = Boolean(evalMatch) && !isInsideStringLiteral(content, evalMatch.index);
      const functionCtor = /\bnew\s+Function\s*\(/.test(bare) || /\bFunction\s*\(\s*['"]/.test(content);
      if (!evalCall && !functionCtor) return [];
      return [
        {
          severity: 'high',
          message: 'Código dinâmico executado em runtime.',
          why: 'eval/Function executam qualquer string com os privilégios do processo.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Trocar código dinâmico por dados',
            'javascript',
            "// Para dados, use JSON.parse. Para despachar ações, use um mapa explícito:\n" +
              "const handlers = { soma: (a, b) => a + b, dobro: (a) => a * 2 }\n" +
              'const resultado = handlers[acao]?.(a, b)',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC005',
    title: 'XSS por HTML dinâmico',
    severity: 'high',
    category: 'security',
    description: 'innerHTML/dangerouslySetInnerHTML com conteúdo variável.',
    languages: ['js', 'ts'],
    run({ content }) {
      const assignment = /\.(?:innerHTML|outerHTML)\s*=\s*(.*)$/.exec(content);
      if (assignment && !isInsideStringLiteral(content, assignment.index) && !isLiteralOnly(assignment[1])) {
        return [
          {
            severity: 'high',
            message: 'HTML construído com conteúdo dinâmico via innerHTML.',
            why: 'Um script injetado na string roda no navegador de quem abre a página.',
            code: truncate(content),
            suggestion: infoSuggestion(
              'Usar textContent ou sanitizar',
              'javascript',
              "element.textContent = texto\n\n" +
                "// Se HTML for necessário, sanitize antes:\n" +
                "element.innerHTML = DOMPurify.sanitize(html)",
            ),
          },
        ];
      }
      if (/dangerouslySetInnerHTML\s*=/.test(content)) {
        return [
          {
            severity: 'high',
            message: 'dangerouslySetInnerHTML com conteúdo dinâmico.',
            why: 'O nome do atributo é o aviso: qualquer HTML passa direto para o DOM.',
            code: truncate(content),
            suggestion: infoSuggestion(
              'Sanitizar antes de renderizar',
              'javascript',
              'const clean = DOMPurify.sanitize(html)\nreturn <div dangerouslySetInnerHTML={{ __html: clean }} />',
            ),
          },
        ];
      }
      const writeArg = /document\.write\s*\(([\s\S]*)\)\s*;?\s*$/.exec(content);
      if (writeArg && !isLiteralOnly(writeArg[1])) {
        return [
          {
            severity: 'medium',
            message: 'document.write com conteúdo dinâmico.',
            why: 'Além de bloquear o parser, document.write aceita HTML sem escape.',
            code: truncate(content),
            suggestion: infoSuggestion(
              'Preferir APIs de DOM',
              'javascript',
              'element.append(document.createTextNode(texto))',
            ),
          },
        ];
      }
      return [];
    },
  },
  {
    id: 'SEC006',
    title: 'Criptografia fraca',
    severity: 'medium',
    category: 'security',
    description: 'MD5/SHA-1 usados para hash ou assinatura.',
    languages: ['js', 'ts', 'py', 'java', 'php', 'ruby', 'go'],
    run({ content }) {
      const weak =
        /createHash\s*\(\s*['"](?:md5|sha1)['"]/i.test(content) ||
        /hashlib\.(?:md5|sha1)\s*\(/i.test(content) ||
        /MessageDigest\.getInstance\s*\(\s*['"](?:MD5|SHA-?1)['"]/i.test(content) ||
        /CryptoJS\.(?:MD5|SHA1)\s*\(/i.test(content);
      if (!weak) return [];
      const password = /password|passwd|senha|credential/i.test(content);
      return [
        {
          severity: password ? 'high' : 'medium',
          message: password ? 'Hash de senha com algoritmo quebrado.' : 'Algoritmo de hash fraco (MD5/SHA-1).',
          why: 'MD5 e SHA-1 têm colisões conhecidas e são rápidos demais para senhas.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Usar um algoritmo adequado',
            'javascript',
            "// Senhas: bcrypt, scrypt ou argon2\n" +
              "const hash = await bcrypt.hash(password, 12)\n\n" +
              "// Integridade: SHA-256\nconst digest = createHash('sha256').update(data).digest('hex')",
          ),
        },
      ];
    },
  },
  {
    id: 'SEC007',
    title: 'TLS desabilitado',
    severity: 'high',
    category: 'security',
    description: 'Verificação de certificado desligada.',
    languages: ['js', 'ts', 'py', 'go', 'java', 'csharp', 'php', 'shell'],
    run({ content }) {
      const patterns = [
        /rejectUnauthorized\s*:\s*false/i,
        /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
        /verify\s*=\s*False/i,
        /InsecureSkipVerify\s*:\s*true/i,
        /curl\s+[^\n]*\s-k\b/,
      ];
      if (!patterns.some((re) => re.test(content))) return [];
      return [
        {
          severity: 'high',
          message: 'Verificação de certificado TLS desligada.',
          why: 'Sem validar o certificado, qualquer intermediário pode ler e alterar o tráfego.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Reativar a verificação',
            'text',
            'Remova a opção que desliga a verificação. Se o problema é um certificado interno,\n' +
              'configure a CA da empresa (NODE_EXTRA_CA_CERTS) em vez de confiar em tudo.',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC008',
    title: 'Aleatoriedade insegura',
    severity: 'medium',
    category: 'security',
    description: 'Math.random/random usados para tokens ou segredos.',
    languages: ['js', 'ts', 'py'],
    run({ content }) {
      const random = /Math\.random\s*\(|\brandom\.(?:random|randint|choice|choices)\s*\(/.test(content);
      if (!random) return [];
      const sensitive =
        /(?:token|secret|password|passwd|nonce|session|otp|salt|uuid|credential|api[_-]?key|private[_-]?key)/i.test(
          stripStrings(content),
        );
      if (!sensitive) return [];
      return [
        {
          severity: 'medium',
          message: 'Valor sensível gerado com PRNG não criptográfico.',
          why: 'Math.random/random são previsíveis o suficiente para permitir adivinhar tokens.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Usar CSPRNG',
            'javascript',
            "const { randomBytes, randomUUID } = require('node:crypto')\n\n" +
              "const token = randomBytes(32).toString('hex')\nconst id = randomUUID()",
          ),
        },
      ];
    },
  },
  {
    id: 'SEC009',
    title: 'Path traversal',
    severity: 'high',
    category: 'security',
    description: 'Caminho de arquivo montado com entrada da requisição.',
    languages: ['js', 'ts', 'py', 'go', 'rb'],
    run({ content }) {
      const fsFunctions =
        '\\b(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync|rm|rmSync|' +
        'access|stat|sendFile|download)\\s*\\([^)]*';
      const requestSource = '(?:req\\.|request\\.|ctx\\.|params\\.|query\\.|body\\.)';
      const fsCall = new RegExp(fsFunctions + requestSource);
      const pathJoin = new RegExp(
        String.raw`(?:path\.(?:join|resolve)|resolve)\s*\([^)]*(?:req\.|request\.|ctx\.)`,
      );
      const fsMatch = fsCall.exec(content);
      const pathMatch = pathJoin.exec(content);
      if (!fsMatch && !pathMatch) return [];
      if (isInsideStringLiteral(content, (fsMatch || pathMatch).index)) return [];
      return [
        {
          severity: 'high',
          message: 'Caminho de arquivo construído com entrada do usuário.',
          why: 'Um `../` na entrada permite ler ou sobrescrever arquivos fora do diretório previsto.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Restringir ao diretório permitido',
            'javascript',
            "const root = path.resolve('public')\n" +
              'const requested = path.resolve(root, path.basename(req.params.file))\n' +
              "if (!requested.startsWith(root + path.sep)) throw new Error('caminho inválido')\n" +
              'const content = await readFile(requested, \'utf8\')',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC010',
    title: 'Desserialização insegura',
    severity: 'high',
    category: 'security',
    description: 'pickle/yaml.load/unserialize com dados externos.',
    languages: ['py', 'rb', 'php', 'js', 'ts', 'java'],
    run({ content }) {
      const patterns = [
        /pickle\.loads?\s*\(/,
        /yaml\.load\s*\((?![^)]*SafeLoader)/,
        /unserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/,
        /Marshal\.load\s*\(/,
        /serialize\.unserialize\s*\(/,
      ];
      if (!patterns.some((re) => re.test(content))) return [];
      return [
        {
          severity: 'high',
          message: 'Desserialização de dados não confiáveis.',
          why: 'Formatos como pickle podem executar código durante o load.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Usar formato seguro',
            'python',
            'import json\n\n' +
              'data = json.loads(payload)  # ou yaml.safe_load(payload)\n' +
              '# Nunca passe pickle.loads para dados de fora do processo.',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC011',
    title: 'SSRF',
    severity: 'medium',
    category: 'security',
    description: 'Requisição para URL controlada pelo usuário.',
    languages: ['js', 'ts', 'py', 'go', 'java', 'php'],
    run({ content }) {
      const request =
        /\b(?:fetch|axios(?:\.\w+)?|got|request|http\.get|https\.get)\s*\(\s*(?:req|request|ctx)\.(?:query|body|params|url)/;
      if (!request.test(content)) return [];
      return [
        {
          severity: 'medium',
          message: 'URL de requisição controlada pela entrada do usuário.',
          why: 'O servidor pode ser usado para acessar a rede interna (169.254.169.254, localhost).',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Validar host com allowlist',
            'javascript',
            "const url = new URL(req.query.url)\n" +
              "const allowed = new Set(['api.exemplo.com', 'cdn.exemplo.com'])\n" +
              "if (!allowed.has(url.hostname)) throw new Error('host não permitido')\n" +
              'const response = await fetch(url)',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC012',
    title: 'Redirect aberto',
    severity: 'medium',
    category: 'security',
    description: 'Redirect para destino vindo da requisição.',
    languages: ['js', 'ts', 'py', 'php', 'go'],
    run({ content }) {
      if (!/(?:res|response|ctx|reply)\.redirect\s*\(\s*(?:req|request|ctx)\./.test(content)) return [];
      return [
        {
          severity: 'medium',
          message: 'Redirecionamento usando destino da requisição.',
          why: 'Abre espaço para phishing com o domínio da aplicação como fachada.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Aceitar apenas destinos conhecidos',
            'javascript',
            "const next = req.query.next\n" +
              "const allowed = ['/painel', '/configuracoes']\n" +
              "res.redirect(allowed.includes(next) ? next : '/painel')",
          ),
        },
      ];
    },
  },
  {
    id: 'SEC013',
    title: 'Segredo em log',
    severity: 'medium',
    category: 'security',
    description: 'Token/senha enviados para logs.',
    languages: ['js', 'ts', 'py', 'rb', 'go', 'php', 'java'],
    run({ content }) {
      const logMatch = /(?:console\.(?:log|info|debug|warn)|logger\.\w+|log\.\w+|print)\s*\(/.exec(content);
      if (!logMatch) return [];
      if (isInsideStringLiteral(content, logMatch.index)) return [];
      const bare = stripStrings(content);
      if (!/(?:token|password|passwd|secret|api[_-]?key|authorization|cookie|session|credential)/i.test(bare)) return [];
      return [
        {
          severity: 'medium',
          message: 'Credencial enviada para o log.',
          why: 'Logs são copiados para APMs, arquivos e ferramentas de terceiros.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Mascarar o valor',
            'javascript',
            "const masked = token ? `${token.slice(0, 4)}…` : 'ausente'\nlogger.info({ userId }, 'autenticação concluída')",
          ),
        },
      ];
    },
  },
  {
    id: 'SEC014',
    title: 'Cookie inseguro',
    severity: 'medium',
    category: 'security',
    description: 'Cookie sem httpOnly/secure ou com SameSite=None.',
    languages: ['js', 'ts', 'py', 'php', 'java', 'go'],
    run({ content }) {
      const flags = [
        /httpOnly\s*:\s*false/i.test(content),
        /secure\s*:\s*false/i.test(content) && /cookie/i.test(content),
        /sameSite\s*:\s*['"]none['"]/i.test(content) && !/secure\s*:\s*true/i.test(content),
      ];
      if (!flags.some(Boolean)) return [];
      return [
        {
          severity: 'medium',
          message: 'Cookie de sessão com proteção reduzida.',
          why: 'Sem httpOnly, um XSS lê o cookie; sem secure, ele trafega em HTTP.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Endurecer o cookie',
            'javascript',
            'res.cookie("sessao", value, {\n' +
              '  httpOnly: true,\n  secure: true,\n  sameSite: "lax",\n  maxAge: 1000 * 60 * 60,\n})',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC015',
    title: 'JWT sem verificação',
    severity: 'high',
    category: 'security',
    description: 'Token decodificado sem validar assinatura ou expiração.',
    languages: ['js', 'ts', 'py', 'java', 'go', 'php'],
    run({ content }) {
      const decodeOnly = /jwt\.decode\s*\(/.test(content) && !/jwt\.verify\s*\(/.test(content);
      const none = /algorithm[^,}]*['"]none['"]/i.test(content);
      const ignoreExpiration = /ignoreExpiration\s*:\s*true|verify_exp\s*:\s*false/i.test(content);
      if (!decodeOnly && !none && !ignoreExpiration) return [];
      return [
        {
          severity: none ? 'critical' : 'high',
          message: none ? 'JWT aceitando o algoritmo "none".' : 'JWT sem validação de assinatura/expiração.',
          why: 'Decodificar não é verificar: qualquer pessoa pode forjar o payload.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Verificar com algoritmo fixo',
            'javascript',
            "const claims = jwt.verify(token, publicKey, {\n" +
              "  algorithms: ['RS256'],\n  issuer: 'https://auth.exemplo.com',\n})",
          ),
        },
      ];
    },
  },
  {
    id: 'SEC016',
    title: 'Injeção NoSQL',
    severity: 'high',
    category: 'security',
    description: 'Objeto da requisição usado direto em filtro de banco.',
    languages: ['js', 'ts', 'py', 'php', 'ruby'],
    run({ content }) {
      const filter = new RegExp(
        '\\.(?:find|findOne|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|aggregate)' +
          '\\s*\\(\\s*(?:req|request)\\.(?:body|query|params)',
      );
      const where = /\$where\s*:/.test(content);
      if (!filter.test(content) && !where) return [];
      return [
        {
          severity: 'high',
          message: 'Objeto da requisição usado diretamente como filtro de banco.',
          why: 'Operadores como `$ne` e `$gt` transformam a query em uma condição sempre verdadeira.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Montar o filtro com campos explícitos',
            'javascript',
            "const { email } = req.body\n" +
              "if (typeof email !== 'string') throw new Error('email inválido')\n" +
              'const user = await User.findOne({ email })',
          ),
        },
      ];
    },
  },
  {
    id: 'SEC017',
    title: 'CORS permissivo',
    severity: 'medium',
    category: 'security',
    description: 'Origem curinga combinada com credenciais.',
    languages: ['js', 'ts', 'py', 'go', 'java', 'php'],
    run({ content, lines, index }) {
      const wildcard = /origin\s*:\s*['"]\*['"]|origin\s*:\s*true/i.test(content);
      if (!wildcard) return [];
      const window = lines.slice(Math.max(0, index - 3), index + 4).map((line) => line.content).join('\n');
      if (!/credentials\s*:\s*true|Allow-Credentials.*true/i.test(window)) return [];
      return [
        {
          severity: 'medium',
          message: 'CORS com origem curinga e credenciais habilitadas.',
          why: 'Qualquer site pode fazer requisições autenticadas em nome do usuário.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Listar origens confiáveis',
            'javascript',
            "const allowed = new Set(['https://app.exemplo.com'])\n" +
              "app.use(cors({ origin: allowed.has(origin) ? origin : false, credentials: true }))",
          ),
        },
      ];
    },
  },
  {
    id: 'SEC018',
    title: 'Poluição de protótipo',
    severity: 'medium',
    category: 'security',
    description: 'Objeto da requisição mesclado em outro objeto.',
    languages: ['js', 'ts'],
    run({ content }) {
      const merge =
        /Object\.assign\s*\(\s*[^,]+,\s*(?:req|request)\.(?:body|query|params)/.test(content) ||
        /\.\.\.(?:req|request)\.body/.test(content);
      if (!merge) return [];
      return [
        {
          severity: 'medium',
          message: 'Objeto da requisição mesclado sem selecionar campos.',
          why: 'Chaves como __proto__/constructor podem alterar o protótipo de outros objetos.',
          code: truncate(content),
          suggestion: infoSuggestion(
            'Selecionar campos explicitamente',
            'javascript',
            "const { nome, email } = req.body\n" +
              'const perfil = Object.assign(Object.create(null), { nome, email })',
          ),
        },
      ];
    },
  },
];
