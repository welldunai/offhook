// Tiny highlighters for the docs' own snippets (author-controlled content only).
// Classes map to the design system's code tokens: tk-s strings, tk-key keys, tk-n numbers and null,
// tk-c comments and punctuation, tk-k commands.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function json(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && !(src[j] === '"' && src[j - 1] !== "\\")) j++;
      const str = src.slice(i, j + 1);
      let k = j + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      out += src[k] === ":" ? `<span class="tk-key">${esc(str)}</span>` : `<span class="tk-s">${esc(str)}</span>`;
      i = j + 1;
    } else if (/^(true|false|null)\b/.test(src.slice(i)) || (/[0-9]/.test(ch) && /[\s:[,]/.test(src[i - 1] ?? " "))) {
      const m = src.slice(i).match(/^(true|false|null|-?[0-9][0-9.eE+-]*)/)![1];
      out += `<span class="tk-n">${m}</span>`;
      i += m.length;
    } else if ("{}[]:,".includes(ch)) {
      out += `<span class="tk-c">${ch}</span>`;
      i++;
    } else {
      out += esc(ch);
      i++;
    }
  }
  return out;
}

function bash(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("#")) return `<span class="tk-c">${esc(line)}</span>`;
      let s = esc(line);
      s = s.replace(/('[^']*'|&quot;[^&]*&quot;|"[^"]*")/g, '<span class="tk-s">$1</span>');
      s = s.replace(/^(\s*)(curl|export|python|npm|pnpm|cd|pip|uv|alembic|docker|createdb|git|ngrok)\b/, '$1<span class="tk-k">$2</span>');
      return s;
    })
    .join("\n");
}

export function highlight(code: string, lang?: string): string {
  if (lang === "json") return json(code);
  if (lang === "bash") return bash(code);
  return esc(code);
}
