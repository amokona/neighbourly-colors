// Sandboxed per-LED 3D math shader compiler & evaluator
// Shared between the Node.js 30 FPS UDP engine (effects.js) and the browser canvas preview (index.html).

const FORBIDDEN_PATTERNS = [
  /['"`]/,                          // No string or template literals
  /[a-zA-Z_$]\s*\./,                // No property access (obj.prop)
  /\.\s*[a-zA-Z_$]/,                // No property access (.prop)
  /[a-zA-Z0-9_$)\]]\s*\[/,          // No bracket indexing (obj[key])
  /\b(while|for|do|function|class|new|import|export|eval|Function|this|super|global|globalThis|window|self|document|process|require|module|exports|fetch|try|catch|throw|async|await|yield|with|delete|typeof|instanceof|in)\b/,
  /=>/                              // No arrow functions
];

const SHADER_HELPERS = {
  PI: Math.PI,
  TAU: Math.PI * 2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  sqrt: Math.sqrt,
  pow: Math.pow,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  mod: (a, b) => ((a % b) + b) % b,
  fract: (x) => x - Math.floor(x),
  clamp: (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v)),
  step: (edge, x) => (x < edge ? 0 : 1),
  smoothstep: (edge0, edge1, x) => {
    const d = edge1 - edge0;
    const t = d === 0 ? 0 : Math.max(0, Math.min(1, (x - edge0) / d));
    return t * t * (3 - 2 * t);
  },
  mix: (a, b, k) => a * (1 - k) + b * k,
  hash: (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  },
  hsv: (h, s = 1, v = 1) => {
    const hn = ((h % 1) + 1) % 1;
    const sn = Math.max(0, Math.min(1, s));
    const vn = Math.max(0, Math.min(1, v));
    const i = Math.floor(hn * 6);
    const f = hn * 6 - i;
    const p = vn * (1 - sn);
    const q = vn * (1 - f * sn);
    const t = vn * (1 - (1 - f) * sn);
    let r = 0, g = 0, b = 0;
    switch (i % 6) {
      case 0: r = vn; g = t; b = p; break;
      case 1: r = q; g = vn; b = p; break;
      case 2: r = p; g = vn; b = t; break;
      case 3: r = p; g = q; b = vn; break;
      case 4: r = t; g = p; b = vn; break;
      case 5: r = vn; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  },
  rgb: (r, g, b) => [
    Math.max(0, Math.min(255, Math.round(r || 0))),
    Math.max(0, Math.min(255, Math.round(g || 0))),
    Math.max(0, Math.min(255, Math.round(b || 0)))
  ]
};

const HELPER_NAMES = Object.keys(SHADER_HELPERS);
const HELPER_VALUES = Object.values(SHADER_HELPERS);

export function compileAiShader(rawCode) {
  if (typeof rawCode !== 'string') {
    throw new Error('Shader code must be a string');
  }

  // Strip comments and normalize Math.fn(...) -> fn(...)
  let code = rawCode
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\bMath\./g, '')
    .trim();

  if (!code || code.length > 1200) {
    throw new Error('Shader code length invalid');
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error(`Shader rejected by sandbox (${pattern})`);
    }
  }

  // If the LLM wrote a bare expression without `return`, wrap it
  const body = /\breturn\b/.test(code) ? code : `return (${code});`;

  const factory = new Function(
    ...HELPER_NAMES,
    'x', 'y', 'z', 'angle', 'index', 'total', 't',
    `"use strict";\n${body}`
  );

  // Smoke-test on sample LEDs & times to verify correctness
  const samples = [
    [0, 0, 1, 0, 0, 2400, 0],
    [0.5, 0.5, 0.5, 0.25, 1200, 2400, 1.5],
    [-0.5, 1, -0.5, 0.75, 2399, 2400, 12.3]
  ];
  for (const s of samples) {
    const out = factory(...HELPER_VALUES, ...s);
    if (!Array.isArray(out) || out.length < 3 || out.length > 4) {
      throw new Error('Shader must return [r, g, b] or [w, r, g, b]');
    }
    for (let i = 0; i < out.length; i++) {
      if (typeof out[i] !== 'number' || Number.isNaN(out[i])) {
        throw new Error('Shader returned non-numeric value');
      }
    }
  }

  return (x, y, z, angle, index, total, t) => {
    const out = factory(...HELPER_VALUES, x, y, z, angle, index, total, t);
    if (out.length === 4) {
      return [
        Math.max(0, Math.min(255, Math.round(out[0]) || 0)),
        Math.max(0, Math.min(255, Math.round(out[1]) || 0)),
        Math.max(0, Math.min(255, Math.round(out[2]) || 0)),
        Math.max(0, Math.min(255, Math.round(out[3]) || 0))
      ];
    }
    const r = Math.max(0, Math.min(255, Math.round(out[0]) || 0));
    const g = Math.max(0, Math.min(255, Math.round(out[1]) || 0));
    const b = Math.max(0, Math.min(255, Math.round(out[2]) || 0));
    const w = (r > 220 && g > 220 && b > 220) ? Math.round((r + g + b) / 3 * 0.65) : 0;
    return [w, r, g, b];
  };
}
