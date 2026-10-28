// Small string helpers. Deliberately regex-free and allocation-light so they stay on scriptc's static, native path.

export function safeDecode(s: string): string {
  if (s.indexOf("%") < 0) return s;
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function decodeQueryComponent(s: string): string {
  if (s.indexOf("+") >= 0) s = s.split("+").join(" ");
  return safeDecode(s);
}

/** Parses `a=1&b=two%20words` into `out`. Repeated keys: the last value wins. */
export function parseQueryString(qs: string, out: Record<string, string>): void {
  const n = qs.length;
  let pos = 0;
  while (pos < n) {
    let amp = qs.indexOf("&", pos);
    if (amp < 0) amp = n;
    if (amp > pos) {
      const eq = qs.indexOf("=", pos);
      if (eq >= 0 && eq < amp) {
        out[decodeQueryComponent(qs.slice(pos, eq))] = decodeQueryComponent(qs.slice(eq + 1, amp));
      } else {
        out[decodeQueryComponent(qs.slice(pos, amp))] = "";
      }
    }
    pos = amp + 1;
  }
}

/** Case-insensitive "does this Content-Type header describe `kind`?" ("json", "text", "urlencoded"). */
export function contentTypeIs(contentType: string, kind: string): boolean {
  const ct = contentType.toLowerCase();
  if (kind === "json") return ct.indexOf("json") >= 0;
  if (kind === "urlencoded") return ct.indexOf("application/x-www-form-urlencoded") >= 0;
  if (kind === "text") return ct.indexOf("text/") >= 0;
  return ct.indexOf(kind.toLowerCase()) >= 0;
}
