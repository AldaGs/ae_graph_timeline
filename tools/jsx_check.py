"""ES3 pre-flight for .jsx files. Not a parser.

It exists because After Effects is the only real syntax check these files get,
and a round trip through AE to find a stray backslash is an expensive way to
learn that.

Derived from the physics-sim jsx_check.py, which checks brace balance and
unterminated strings. That version was fed the exact break that cost this
project a round trip - `s.replace(/\\/g, "x")`, an unterminated regex - and
reported clean, because it has no notion of a regex literal at all. So this one
tracks regex literals too, and additionally refuses any regex containing a
backslash: the house rule here is split/join, precisely because an unterminated
regex is a parse error and AE reports it as a line number with no explanation.

It also flags ES5+ constructs that parse fine in Node and fail in ExtendScript.

  python tools/jsx_check.py jsx/reader.jsx
  exit 0 = clean, exit 1 = problems on stdout
"""
import re
import sys

# Tokens after which a `/` begins a REGEX rather than a division.
PREFIX = set("(,=:[!&|?{};+-*%~^") | {"return", "typeof", "case", "in", "of",
                                      "delete", "void", "instanceof", "new"}

# ES5+ things ExtendScript (ES3) does not have. Checked as source text, so a
# false positive is possible inside a string - cheap next to an AE round trip.
ES5 = [
    (r"\bJSON\s*\.", "JSON is not available in ExtendScript"),
    (r"\b(?:const|let)\s+\w", "const/let are ES6"),
    (r"=>", "arrow functions are ES6"),
    (r"\.trim\s*\(", "String.trim is ES5"),
    (r"\.forEach\s*\(", "Array.forEach is ES5"),
    (r"\.map\s*\(", "Array.map is ES5"),
    (r"\.filter\s*\(", "Array.filter is ES5"),
    (r"Object\.keys", "Object.keys is ES5"),
    (r"\.\.\.", "spread/rest is ES6"),
    # Array.indexOf is ES5, but String.indexOf is ES3 and used everywhere here.
    # The two are indistinguishable in source text, so the rule is left out
    # rather than crying wolf on every string search.
    (r"`", "template literals are ES6"),
]


def check(path):
    src = open(path, encoding="utf-8").read()
    problems = []

    depth = {"{": 0, "(": 0, "[": 0}
    pairs = {"}": "{", ")": "(", "]": "["}
    i = 0
    line = 1
    state = None          # None | '"' | "'" | "//" | "/*" | "re"
    re_start = 0
    re_backslash = False
    prev = ""             # last significant character seen in code

    while i < len(src):
        c = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if c == "\n":
            line += 1
            if state in ('"', "'"):
                problems.append("line %d: newline inside a string literal" % (line - 1))
                state = None
            elif state == "re":
                problems.append("line %d: unterminated regex literal "
                                "(a backslash before the closing slash?)" % re_start)
                state = None
            elif state == "//":
                state = None
            i += 1
            continue

        if state in ("//", "/*"):
            if state == "/*" and c == "*" and nxt == "/":
                state = None
                i += 2
                continue
            i += 1
            continue

        if state in ('"', "'"):
            if c == "\\":
                i += 2
                continue
            if c == state:
                state = None
            i += 1
            continue

        if state == "re":
            if c == "\\":
                re_backslash = True
                i += 2
                continue
            if c == "[":          # a character class can contain an unescaped /
                j = src.find("]", i)
                i = (j + 1) if j != -1 else i + 1
                continue
            if c == "/":
                if re_backslash:
                    problems.append("line %d: regex literal contains a backslash - "
                                    "use split/join instead" % re_start)
                state = None
                prev = "/"
            i += 1
            continue

        if c == "/" and nxt == "/":
            state = "//"
            i += 2
            continue
        if c == "/" and nxt == "*":
            state = "/*"
            i += 2
            continue
        if c == "/":
            # Regex or division? Decided by what came before it.
            word = re.search(r"(\w+)\s*$", src[:i])
            is_regex = (prev in PREFIX) or (word and word.group(1) in PREFIX) or prev == ""
            if is_regex:
                state = "re"
                re_start = line
                re_backslash = False
                i += 1
                continue
            prev = c
            i += 1
            continue

        if c in ('"', "'"):
            state = c
            i += 1
            continue

        if c in depth:
            depth[c] += 1
        elif c in pairs:
            depth[pairs[c]] -= 1
            if depth[pairs[c]] < 0:
                problems.append("line %d: unmatched %s" % (line, c))

        if not c.isspace():
            prev = c
        i += 1

    for k, v in depth.items():
        if v:
            problems.append("%d unclosed %s" % (v, k))
    if state:
        problems.append("file ends inside %s" % state)

    for n, text in enumerate(src.split("\n"), 1):
        code = text.split("//")[0]
        # Blank out string bodies first: a rule must not fire on the text
        # "...(truncated)" sitting inside a string literal.
        code = re.sub(r"'[^']*'", "''", code)
        code = re.sub(r'"[^"]*"', '""', code)
        for pat, msg in ES5:
            if re.search(pat, code):
                problems.append("line %d: %s" % (n, msg))

    return problems


if __name__ == "__main__":
    bad = 0
    for path in sys.argv[1:]:
        found = check(path)
        if found:
            bad = 1
            print(path)
            for p in found:
                print("  " + p)
        else:
            print("%s: clean" % path)
    sys.exit(bad)
