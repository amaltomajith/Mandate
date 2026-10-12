const fs = require("fs");
function sub(p, a, b) {
  let s = fs.readFileSync(p, "utf8");
  const crlf = s.includes("\r\n");
  if (crlf) s = s.replace(/\r\n/g, "\n");
  if (!s.includes(a)) { console.log("MISSING", p, a.slice(0, 60)); return; }
  s = s.replace(a, () => b);
  if (crlf) s = s.replace(/\n/g, "\r\n");
  fs.writeFileSync(p, s);
}
module.exports = { sub };
