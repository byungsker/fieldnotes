import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const tokenPath = "packages/markdown-live-editor/tokens.css";
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const tokens = read(tokenPath);
const design = read("DESIGN.md");
const darkStart = tokens.indexOf(':root[data-theme="dark"]');
assert.ok(darkStart > 0);

function declarations(css: string): Array<[string, string]> {
  return [...css.matchAll(/(?:^|[;{}])\s*(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)(?=;|})/g)]
    .map((match) => [match[1], match[2].trim()]);
}
const light = new Map(declarations(tokens.slice(0, darkStart)));
const dark = new Map([...light, ...declarations(tokens.slice(darkStart))]);
const definitions = new Set(light.keys());

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (/^(node_modules|licenses|examples)$/.test(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(css|tsx?|js|html)$/.test(file) && !/\.test\./.test(file) ? [file] : [];
  });
}
const sources = [...sourceFiles("src"), ...sourceFiles("packages/markdown-live-editor"), "public/theme-init.js", "index.html"];
const rawColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|color-mix)\s*\(/i;

test("제품 스타일과 테마 메타데이터의 색상은 단일 토큰 정의만 참조한다", () => {
  for (const file of sources.filter((file) => file !== tokenPath)) {
    const source = read(file);
    assert.doesNotMatch(source, rawColor, `${file}: 원시 색상 대신 의미 토큰을 사용한다`);
    if (file.endsWith(".tsx")) assert.doesNotMatch(source, /<[A-Z][\w.]+\b[^>]*\bsize=\{\s*\d+\s*\}/, `${file}: 아이콘은 공통 크기 토큰을 사용한다`);
    if (!file.endsWith(".css")) continue;
    for (const [property, value] of declarations(source)) {
      assert.ok(!property.startsWith("--ds-"), `${file}: 공통 토큰을 다시 정의하지 않는다`);
      if (/color|background|border|outline|shadow/.test(property)) {
        assert.doesNotMatch(value, /\b(?:white|black|gray|grey|red|blue|green|pink|orange|purple|yellow)\b/i, file);
      }
    }
  }
  assert.match(read("packages/markdown-live-editor/styles.css"), /^@import ['"]\.\/tokens\.css['"]/);
  for (const file of ["public/theme-init.js", "src/pages/workspace/ui/WorkspacePage.tsx"]) {
    assert.match(read(file), /getComputedStyle\(document\.documentElement\)\.getPropertyValue\("--ds-color-canvas"\)/);
  }
});

test("글자·간격·모서리·그림자·움직임은 공통 척도를 사용하고 모든 토큰 참조는 정의되어 있다", () => {
  const primitive = /^(?:font(?:-size|-family|-weight)?|line-height|letter-spacing|(?:padding|margin)(?:-[a-z]+)?|gap|row-gap|column-gap|border(?:-[a-z]+)?-radius|box-shadow|transition(?:-[a-z]+)?|animation(?:-[a-z]+)?)$/;
  for (const file of sources) {
    const source = read(file);
    for (const match of source.matchAll(/var\((--ds-[\w-]+)/g)) assert.ok(definitions.has(match[1]), `${file}: ${match[1]}`);
    if (file === tokenPath || !file.endsWith(".css")) continue;
    for (const [property, value] of declarations(source)) {
      if (!primitive.test(property)) continue;
      const mechanics = value.replace(/var\([^)]+\)/g, "");
      assert.doesNotMatch(mechanics, /(?:^|[\s(,])[-.\d]+(?:px|em|rem|ms|s)\b/, `${file}: ${property}: ${value}`);
      if (/^(font-size|font-weight|line-height|letter-spacing)$/.test(property)) {
        assert.doesNotMatch(mechanics, /(?:^|\s)[1-9]\d*(?:\.\d+)?(?:\s|$)/, `${file}: ${property}: ${value}`);
      }
    }
  }
});

test("DESIGN.md의 테마·글자·간격 표는 실행 토큰과 일치한다", () => {
  const described = new Set([...design.matchAll(/--ds-[\w-]+/g)].map(([name]) => name));
  for (const match of design.matchAll(/(--ds-[\w-]+)((?:\/[\w-]+)+)/g)) {
    const prefix = match[1].slice(0, match[1].lastIndexOf("-") + 1);
    for (const suffix of match[2].slice(1).split("/")) described.add(prefix + suffix);
  }
  for (const [name] of light) {
    if (!name.startsWith("--ds-space-")) assert.ok(described.has(name), `${name}: 문서에 용도가 없다`);
  }
  const lightColors = [...light].filter(([name, value]) => name.startsWith("--ds-color-") && value.startsWith("#"));
  const darkColors = declarations(tokens.slice(darkStart));
  assert.deepEqual(darkColors.map(([name]) => name).sort(), lightColors.map(([name]) => name).sort());
  for (const [name, value] of lightColors) {
    assert.ok(design.includes(`| \`${name}\` | \`${value}\` | \`${dark.get(name)}\` |`), name);
  }
  for (const [name, value] of light) {
    if (name.startsWith("--ds-text-")) assert.ok(design.includes(`| \`${name}\` | \`${value}\` |`), name);
    if (name.startsWith("--ds-space-")) assert.ok(design.includes(`| \`${name.slice("--ds-space-".length)}\` | \`${value}\` |`), name);
  }
});

test("앱과 편집기의 공개 호환 별칭은 같은 의미 토큰으로 해석된다", () => {
  const aliases = new Map([
    ...declarations(read("packages/markdown-live-editor/styles.css")),
    ...declarations(read("src/app/styles.css")),
  ].filter(([name]) => name.startsWith("--")));
  function resolve(name: string, seen = new Set<string>()): string {
    if (name.startsWith("--ds-")) return name;
    assert.ok(!seen.has(name), `${name}: 순환 별칭`);
    seen.add(name);
    const target = aliases.get(name)?.match(/^var\((--[\w-]+)\)$/)?.[1];
    assert.ok(target, `${name}: 토큰 별칭이 아니다`);
    return resolve(target, seen);
  }
  for (const [editor, app, role] of [
    ["--mle-border", "--line", "line"], ["--mle-muted", "--muted", "muted"],
    ["--mle-ink", "--ink", "ink"], ["--mle-surface", "--surface", "surface"],
    ["--mle-soft", "--canvas", "canvas"], ["--mle-accent", "--accent", "accent"],
  ]) {
    assert.equal(resolve(editor), `--ds-color-${role}`);
    assert.equal(resolve(app), resolve(editor));
  }
});

function resolveColor(theme: Map<string, string>, name: string): string {
  const value = theme.get(`--ds-color-${name}`);
  assert.ok(value, name);
  const alias = value.match(/^var\(--ds-color-([\w-]+)\)$/);
  return alias ? resolveColor(theme, alias[1]) : value;
}
function luminance(hex: string): number {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const [r, g, b] = hex.slice(1).match(/../g)!.map((part) => {
    const channel = Number.parseInt(part, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

test("두 테마의 본문·메타데이터·상태·버튼 텍스트는 실제 면에서 4.5:1 대비를 유지한다", () => {
  const pairs = [
    ...["surface", "canvas", "raised", "hover", "selected"].flatMap((background) => [
      ["ink", background], ["muted", background], ["accent", background],
    ]),
    ["on-accent", "accent"], ["on-accent", "accent-hover"], ["on-fill", "danger-fill"],
    ["danger", "danger-soft"], ["warning", "warning-soft"], ["info", "info-soft"],
    ["rose", "rose-soft"], ["violet", "violet-soft"], ["highlight-ink", "highlight"],
  ];
  for (const [themeName, theme] of [["light", light], ["dark", dark]] as const) {
    for (const [foreground, background] of pairs) {
      const a = luminance(resolveColor(theme, foreground));
      const b = luminance(resolveColor(theme, background));
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.ok(ratio >= 4.5, `${themeName} ${foreground}/${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});
