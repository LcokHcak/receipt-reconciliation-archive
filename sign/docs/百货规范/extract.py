import re, io, zipfile, sys


def extract(path):
    z = zipfile.ZipFile(path)
    parts = []
    for name in z.namelist():
        if re.match(r"word/(document|header\d*|footer\d*)\.xml$", name):
            parts.append(z.read(name).decode("utf-8", "ignore"))
    xml = "\n".join(parts)
    # paragraph-aware: split on </w:p>, within each grab w:t
    out = []
    for para in xml.split("</w:p>"):
        ts = re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, re.S)
        line = "".join(ts)
        line = (
            line.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&#x2019;", "'")
        )
        if line.strip():
            out.append(line)
    return "\n".join(out)


out = extract(sys.argv[1])
io.open(sys.argv[2], "w", encoding="utf-8").write(out)
print("written", len(out), "chars")
