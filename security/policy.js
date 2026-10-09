// /security/policy.js
// Policy ครอบคลุม C++ + Python + Sandbox (เวอร์ชันสมบูรณ์ ปลอดภัย)

// ------------------------------------------------------------------
// Compatibility — ป้องกัน grader_cpp.js เก่าเรียก cppForbiddenDefines แล้วพัง
export const cppForbiddenDefines = [];

// ------------------------------------------------------------------
// Regex สำหรับตรวจโค้ด C++
// NOTE: connect/accept/bind/listen( are deliberately NOT matched: they are common names in
// legitimate solutions (union-find `connect(a, b)`, `std::bind`). Network use needs a header
// (blocked below) or a raw socket()/getaddrinfo() call (blocked below).
export const cppForbiddenRegex = [
  /\bsystem\s*\(/,
  /\b_?wsystem\s*\(/,
  /\b_?popen\s*\(/,
  /\bpclose\s*\(/,
  /\bfork\s*\(/,
  /\b_?exec(v|le|lp|ve|vp|vpe)?\s*\(/,
  /\b_?spawn(v|l)(p|e|pe)?\s*\(/,
  /\bsocket\s*\(/,
  /\bgetaddrinfo\s*\(/,
  /\b(CreateProcess|WinExec|ShellExecute|CreateThread|LoadLibrary|GetProcAddress|URLDownloadToFile)[AWEx]*\s*\(/,
  /#\s*include\s*<sys\//,
  /#\s*include\s*<arpa\//,
  /#\s*include\s*<netinet\//,
  /#\s*include\s*<unistd\.h>/,
  /#\s*include\s*<(windows|winsock2?|ws2tcpip|winternl|shellapi|tlhelp32|process|direct|io)\.h>/i,
  // #include of a file by path: lets the compiler read arbitrary files into error messages/binaries
  /#\s*include\s*"[^"]*(?:[\\/]|\.\.|:)[^"]*"/,
  /#\s*include\s*"[^"]*\.(?:json|txt|log|js|pem|key|env|db)"/i,
  /#\s*(?:embed|import|include_next)\b/,
  /\.incbin\b/,
  /\b(?:__asm__|__asm|asm)\b\s*(?:volatile\s*)?\(/,
  /\bopen\s*\(\s*["']\/(?:proc|etc|dev)/i,
  /\bfopen\s*\(\s*["']\/(?:proc|etc|dev)/i,
  /\bf?open\s*\(\s*["'](?:[A-Za-z]:|\\\\|\.\.[\\/])/,
  /\bfreopen\s*\(/,
  /\bptrace\s*\(/,
];

// ฟังก์ชันตรวจโค้ด C++
export function scanCppCode(src = '') {
  const hits = [];
  // the preprocessor splices backslash-continued lines before tokenising; do the same here
  const lines = src.replace(/\\\r?\n/g, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    cppForbiddenRegex.forEach(rx => {
      if (rx.test(line)) hits.push({ line: i + 1, pattern: rx.toString(), code: line.trim() });
    });
  });
  return { ok: hits.length === 0, hits };
}

// ------------------------------------------------------------------
// Regex สำหรับตรวจโค้ด Python
// Modules that give file-system / process / network / native access. Matched in `import a, b`,
// `from a.b import c`, and bare attribute use. This is an early reject, not a boundary — the runtime
// sandbox is the boundary.
const PY_BAD_MODULES = [
  'os', 'posix', 'nt', 'subprocess', 'socket', 'ctypes', '_ctypes', 'cffi', 'resource', 'fcntl', 'shutil', 'pathlib',
  'glob', 'fnmatch', 'tempfile', 'importlib', 'builtins', '_io', 'io', 'multiprocessing', 'pty', 'signal', 'mmap',
  'sqlite3', 'pickle', 'marshal', 'shelve', 'zipfile', 'tarfile', 'urllib', 'http', 'ftplib', 'smtplib', 'ssl',
  'requests', 'webbrowser', 'winreg', '_winapi', 'msvcrt', 'code', 'codeop', 'pdb', 'runpy', 'pkgutil', 'site',
];
const PY_BAD_ALT = PY_BAD_MODULES.join('|');
export const pyForbiddenRegex = [
  new RegExp(`\\bimport\\b[^#\\n]*\\b(?:${PY_BAD_ALT})\\b`),
  new RegExp(`\\bfrom\\s+(?:${PY_BAD_ALT})\\b`),
  /\bos\.(?:system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|listdir|scandir|walk)\b/,
  /\bsubprocess\./,
  /\b__import__\b/,
  /\b__builtins__\b/,
  /\b__(?:subclasses|globals|loader|spec|code|closure|defaults|self|func|getattribute|reduce|reduce_ex)__\b/,
  /\b_os\b|\bsys\.modules\b|\b_?getframe\b|\bf_(?:globals|builtins|back)\b|\btb_frame\b|\bgi_frame\b/,
  /\b(?:exec|eval|compile)\s*\(/,
  /\b(?:globals|locals|vars|breakpoint)\s*\(/,
  /\bopen\s*\(/,
  /\bctypes\b/,
  /\bcffi\b/,
];

// ฟังก์ชันตรวจโค้ด Python
export function scanPythonCode(src = '') {
  const hits = [];
  // join backslash-continued lines so `import \<newline> os` can't hide from the line-based regexes
  const lines = src.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  lines.forEach((line, i) => {
    pyForbiddenRegex.forEach(rx => {
      if (rx.test(line)) hits.push({ line: i + 1, pattern: rx.toString(), code: line.trim() });
    });
  });
  return { ok: hits.length === 0, hits };
}

// Human-readable summary of scan hits for compile logs (student-facing).
export function describeHits(hits = []) {
  return hits.slice(0, 5).map(h => `line ${h.line}: ${h.code.slice(0, 80)}`).join('\n')
    + (hits.length > 5 ? `\n... and ${hits.length - 5} more` : '');
}

// ------------------------------------------------------------------
// Sandbox settings
export function runtimeShellPrefix(memMB = 256, timeMs = 2000) {
  // จำกัด CPU, RAM, fd, file size, no core dump (CPU seconds are a backstop above the `timeout` wall-clock limit)
  return `ulimit -t ${Math.ceil(timeMs / 1000) + 1}; ulimit -v ${Math.round(memMB) * 1024}; ulimit -n 64; ulimit -f 10240; ulimit -c 0; `;
}

export function maybeSandbox(cmd) {
  // ใช้ firejail ถ้ามี (ตัด network + private FS + drop caps)
  return `if command -v firejail >/dev/null 2>&1; then \
firejail --quiet --net=none --private --nosound --caps.drop=all -- ${cmd}; \
else ${cmd}; fi`;
}
