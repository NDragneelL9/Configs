#!/usr/bin/env python
# Presidio-based redactor: markdown on stdin -> sanitized file + report.
# Detection: NER (ru+en, PERSON only) + built-ins (email/phone/ip) + custom
# recognizers (RU doc numbers with checksums, keyword creds/logins/names,
# JWT, url-creds, hostnames/system names for pseudonymization).
# Redaction operators preserve context (keyword prefixes stay readable).
# Report contains masked samples only; raw values never leave this process
# (except the local mappings.json for pseudonyms — never to be sent to an LLM).

import sys
import re
import json
import argparse
from pathlib import Path

from presidio_analyzer import AnalyzerEngine, RecognizerRegistry, Pattern, PatternRecognizer
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent

# ---------- checksums ----------

def inn_valid(digits: str) -> bool:
    d = [int(c) for c in digits]
    if len(d) == 10:
        w = [2, 4, 10, 3, 5, 9, 4, 6, 8]
        return sum(x * y for x, y in zip(d[:9], w)) % 11 % 10 == d[9]
    if len(d) == 12:
        w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        return (sum(x * y for x, y in zip(d[:10], w1)) % 11 % 10 == d[10]
                and sum(x * y for x, y in zip(d[:11], w2)) % 11 % 10 == d[11])
    return False


def snils_valid(digits: str) -> bool:
    if len(digits) != 11 or not digits.isdigit():
        return False
    d = [int(c) for c in digits]
    s = sum(d[i] * (9 - i) for i in range(9))
    k = s if s < 100 else (0 if s in (100, 101) else s % 101)
    return k == d[9] * 10 + d[10]


# ---------- validating recognizers ----------

class InnRecognizer(PatternRecognizer):
    PATTERNS = [Pattern("inn", r"(?<![\d])(?:ИНН|INN)\s*[№N:]?\s*(\d{10}|\d{12})(?!\d)", 0.95)]

    def __init__(self):
        super().__init__(supported_entity="INN_RU", patterns=self.PATTERNS,
                         supported_language="ru", name="InnRecognizer")

    def validate_result(self, pattern_text: str) -> bool:
        m = re.search(r"\d{10}|\d{12}", pattern_text)
        return bool(m and inn_valid(m.group(0)))


class SnilsRecognizer(PatternRecognizer):
    PATTERNS = [Pattern("snils", r"(?<![\d])(?:СНИЛС)?\s*(?:№\s*)?\b(\d{3})-(\d{3})-(\d{3})\s(\d{2})\b(?!\d)", 0.9)]

    def __init__(self):
        super().__init__(supported_entity="SNILS_RU", patterns=self.PATTERNS,
                         supported_language="ru", name="SnilsRecognizer")

    def validate_result(self, pattern_text: str) -> bool:
        m = re.search(r"\d{3}-\d{3}-\d{3}\s\d{2}", pattern_text)
        return bool(m and snils_valid(m.group(0).replace("-", "").replace(" ", "")))


# ---------- masking / reporting ----------

def mask_value(v: str) -> str:
    if len(v) <= 4:
        return "***"
    at = v.find("@")
    if at > 0 and v.find(".", at) > at:
        return v[:1] + "***@" + v[at + 1:]
    return v[:2] + "***" + v[-1:]


class RedactionOps:
    """Custom-operator factory: records findings, keeps context prefixes, counts placeholders."""

    SECRET_TYPES = {"CRED_KEYWORD", "JWT", "URL_CREDS", "API_KEY"}

    def __init__(self, mapping, mappings_dirty):
        self.counters = {}
        self.counts = {}
        self.findings = []          # {"type","masked"} only
        self.secret_raws = set()    # raw values of secret-type hits, never exported
        self.mapping = mapping
        self.mappings_dirty = mappings_dirty
        self.new_pseudonyms = []

    def _ph(self, etype, raw):
        self.counters[etype] = self.counters.get(etype, 0) + 1
        self.counts[etype] = self.counts.get(etype, 0) + 1
        self.findings.append({"type": etype, "masked": mask_value(raw)})
        if etype in self.SECRET_TYPES:
            self.secret_raws.add(raw)
        return f"[REDACTED:{etype}:{self.counters[etype]}]"

    def split_op(self, etype):
        """keyword prefix (up to last ':'/'=') stays, value -> placeholder"""
        def op(text: str) -> str:
            i = max(text.rfind(":"), text.rfind("="))
            raw = text[i + 1:].strip().strip("'\"«»") if i > 0 else text
            ph = self._ph(etype, raw)
            return (text[:i + 1] + " " + ph) if i > 0 else ph
        return op

    def name_op(self, etype, name_re):
        """trailing human name -> placeholder, prefix stays"""
        rx = re.compile(name_re)

        def op(text: str) -> str:
            m = rx.search(text)
            if not m:
                return self._ph(etype, text)
            ph = self._ph(etype, m.group(0))
            return text[:m.start()] + ph
        return op

    def tail_op(self, etype):
        """last whitespace token -> placeholder (logins)"""
        def op(text: str) -> str:
            raw = text.split()[-1] if text.split() else text
            ph = self._ph(etype, raw)
            idx = text.rfind(raw)
            return text[:idx] + ph
        return op

    def plain_op(self, etype):
        def op(text: str) -> str:
            return self._ph(etype, text)
        return op

    def url_creds_op(self):
        def op(text: str) -> str:
            m = re.match(r"([a-z][a-z0-9+.-]*://)(.+):(.+)@", text, re.I)
            ph = self._ph("URL_CREDS", m.group(2) + ":" + m.group(3) if m else text)
            return (m.group(1) + ph + "@") if m else ph
        return op

    def pseudonym_op(self, etype, prefix):
        def op(text: str) -> str:
            value = text.strip()
            for e in self.mapping:
                if e["real"].lower() == value.lower() and e["type"] == etype:
                    return e["pseudo"]
            n = 1 + sum(1 for e in self.mapping if e["type"] == etype)
            pseudo = f"{prefix}-{n}"
            self.mapping.append({"type": etype, "real": value, "pseudo": pseudo})
            self.new_pseudonyms.append({"pseudo": pseudo, "type": etype})
            return pseudo
        return op


# ---------- main ----------

def build_recognizers(cfg):
    ru, en = [], []

    def pat(name, regex, score, entity, lang):
        rec = PatternRecognizer(supported_entity=entity, patterns=[Pattern(name, regex, score)],
                                supported_language=lang, name=name, context=None)
        (ru if lang == "ru" else en).append(rec)

    W = r"(?<![а-яА-ЯёЁ\w])"   # non-word lookbehind (cyrillic-aware)
    NWE = r"(?![а-яА-ЯёЁ\w])"  # non-word lookahead

    # --- ru keyword creds/logins/names ---
    pat("ru-cred", W + r"(?:пароль|секрет|токен)" + NWE + r"(?:\s+[а-яёА-ЯЁ-]{1,20}){0,3}\s*[:=]\s*[\"'«]?[^\s\"'»]{4,}", 0.9, "CRED_KEYWORD", "ru")
    pat("ru-login", W + r"(?:логин|учётная\s+запись|учетка|учетная\s+запись|пользователь)" + NWE + r"(?:\s+\S+){0,2}\s*[:=]\s*[\"'«]?[\w.\-@]{2,}", 0.85, "LOGIN", "ru")
    pat("ru-person-ctx", W + r"(?:ответственный|автор|исполнитель|владелец|заказчик|контакт(?:ное\s+лицо)?)(?:\s+за\s+\S+)?\s*[:—-]\s*[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){0,2}", 0.9, "PERSON_CTX", "ru")
    pat("ru-phone", r"(?:\+7|8)[\s(-]*\d{3}[\s)-]*\s*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b", 0.9, "PHONE_NUMBER", "ru")
    pat("ru-passport", W + r"(?:паспорт|серия)(?:\s+РФ)?\s*[№N:]?\s*\d{4}\s?\d{6}(?!\d)", 0.95, "PASSPORT_RU", "ru")

    # --- en keyword creds/logins/names ---
    pat("en-cred-env", r"(?<![\w])[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY)[A-Za-z_]*\s*[:=]\s*[\"']?[^\s\"']{4,}", 0.9, "CRED_KEYWORD", "en")
    pat("en-cred-word", r"(?<![\w])(?:password|secret|token|pwd)(?:\s+\w+){0,3}\s*[:=]\s*[\"']?[^\s\"']{4,}", 0.9, "CRED_KEYWORD", "en")
    pat("en-login", r"(?<![\w])(?:login|username|user(?:\s*name)?)(?:\s+\w+){0,2}\s*[:=]\s*[\w.\-@]{2,}", 0.85, "LOGIN", "en")
    pat("en-person-ctx", r"(?<![\w])(?:responsible|author|owner|contact(?:\s+person)?)(?:\s+\w+){0,2}\s*[:\-]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}", 0.85, "PERSON_CTX", "en")

    # --- language-agnostic ---
    for lang in ("ru", "en"):
        pat("jwt", r"\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b", 0.95, "JWT", lang)
        pat("url-creds", r"\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@", 0.95, "URL_CREDS", lang)
        # safety net for gitleaks allowlisted examples (e.g. AKIAIOSFODNN7EXAMPLE)
        pat("api-key", r"\b(?:sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{10,})\b", 0.95, "API_KEY", lang)

    # --- technical pseudonymization targets ---
    domains = [re.escape(d.strip().lower()) for d in cfg.get("internal_domains", []) if d.strip()]
    if domains:
        host_rx = r"\b(?:[a-z0-9][a-z0-9-]*\.)+(?:" + "|".join(domains) + r")\b"
        for lang in ("ru", "en"):
            pat("tech-hostname", host_rx, 0.9, "TECH_HOSTNAME", lang)
    systems = [re.escape(s) for s in cfg.get("system_names", []) if s]
    if systems:
        sys_rx = r"(?<![\w])(?:" + "|".join(systems) + r")(?![\w])"
        for lang in ("ru", "en"):
            pat("tech-system", sys_rx, 0.95, "TECH_SYSTEM", lang)

    recs = ru + en + [InnRecognizer(), SnilsRecognizer()]
    return recs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--mappings", default=str(Path.home() / ".cache" / "confluence-docs" / "mappings.json"))
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    text = sys.stdin.read()
    if not text.strip():
        print(json.dumps({"error": "empty input"}))
        sys.exit(1)

    mappings_path = Path(args.mappings)
    mappings_path.parent.mkdir(parents=True, exist_ok=True)
    mapping = json.loads(mappings_path.read_text(encoding="utf-8")) if mappings_path.exists() else []
    mappings_dirty = False

    nlp_cfg = {
        "nlp_engine_name": "spacy",
        "models": [
            {"lang_code": "ru", "model_name": cfg.get("ner_models", {}).get("ru", "ru_core_news_lg")},
            {"lang_code": "en", "model_name": cfg.get("ner_models", {}).get("en", "en_core_web_lg")},
        ],
        "ner_model_configuration": {
            "labels_to_ignore": [
                "LOC", "GPE", "ORG", "ORGANIZATION", "DATE", "TIME", "CARDINAL", "MONEY",
                "PERCENT", "ORDINAL", "QUANTITY", "NORP", "FAC", "EVENT", "PRODUCT",
                "LAW", "LANGUAGE", "WORK_OF_ART", "MISC", "GPE_LOC",
            ],
            "model_to_presidio_entity_mapping": {
                "PERSON": "PERSON", "PER": "PERSON", "LOC": "LOCATION", "GPE": "LOCATION",
                "FAC": "LOCATION", "ORG": "ORGANIZATION", "ORGANIZATION": "ORGANIZATION",
            },
            "low_confidence_score_multiplier": 0.4,
            "low_score_entity_names": [],
        },
    }
    engine = NlpEngineProvider(nlp_configuration=nlp_cfg).create_engine()
    registry = RecognizerRegistry(supported_languages=["ru", "en"])
    registry.load_predefined_recognizers(["ru", "en"])
    analyzer = AnalyzerEngine(registry=registry, nlp_engine=engine, supported_languages=["ru", "en"])
    for rec in build_recognizers(cfg):
        analyzer.registry.add_recognizer(rec)
    # built-in URL recognizer whole-URL spans and breaks hostname pseudonymization
    # inside links — we handle URLs ourselves (URL_CREDS + TECH_HOSTNAME)
    for rec in list(analyzer.registry.recognizers):
        if "URL" in rec.supported_entities:
            analyzer.registry.remove_recognizer(rec.name)

    results = list(analyzer.analyze(text=text, language="ru", score_threshold=0.4))
    res_en = list(analyzer.analyze(text=text, language="en", score_threshold=0.4))

    # en NER on Cyrillic text produces garbage ("Тел." as PERSON) — keep en person
    # entities only when the span is mostly Latin-script
    def latin_ratio(s):
        letters = [c for c in s if c.isalpha()]
        return (sum(1 for c in letters if ord(c) < 128) / len(letters)) if letters else 1.0

    res_en = [r for r in res_en
              if r.entity_type not in ("PERSON", "PERSON_CTX")
              or latin_ratio(text[r.start:r.end]) >= 0.5]
    results += res_en

    whitelist = [re.compile(w, re.I) for w in cfg.get("whitelist", [])]
    if whitelist:
        results = [r for r in results if not any(w.search(text[r.start:r.end]) for w in whitelist)]

    ops = RedactionOps(mapping, mappings_dirty)
    anonymize_tech = cfg.get("anonymize_technical", True)

    operators = {
        "PERSON": OperatorConfig("custom", {"lambda": ops.plain_op("PERSON")}),
        "PERSON_CTX": OperatorConfig("custom", {"lambda": ops.name_op("PERSON_CTX", r"[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){0,2}$|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}$")}),
        "EMAIL_ADDRESS": OperatorConfig("custom", {"lambda": ops.plain_op("EMAIL_ADDRESS")}),
        "PHONE_NUMBER": OperatorConfig("custom", {"lambda": ops.plain_op("PHONE_NUMBER")}),
        "CRED_KEYWORD": OperatorConfig("custom", {"lambda": ops.split_op("CRED_KEYWORD")}),
        "LOGIN": OperatorConfig("custom", {"lambda": ops.tail_op("LOGIN")}),
        "JWT": OperatorConfig("custom", {"lambda": ops.plain_op("JWT")}),
        "API_KEY": OperatorConfig("custom", {"lambda": ops.plain_op("API_KEY")}),
        "URL_CREDS": OperatorConfig("custom", {"lambda": ops.url_creds_op()}),
        "INN_RU": OperatorConfig("custom", {"lambda": ops.split_op("INN_RU")}),
        "SNILS_RU": OperatorConfig("custom", {"lambda": ops.split_op("SNILS_RU")}),
        "PASSPORT_RU": OperatorConfig("custom", {"lambda": ops.split_op("PASSPORT_RU")}),
        "TECH_HOSTNAME": OperatorConfig("custom", {"lambda": ops.pseudonym_op("TECH_HOSTNAME", "host")}),
        "TECH_SYSTEM": OperatorConfig("custom", {"lambda": ops.pseudonym_op("TECH_SYSTEM", "sys")}),
        "IP_ADDRESS": OperatorConfig(
            "custom",
            {"lambda": (ops.pseudonym_op("IP_ADDRESS", "ip") if anonymize_tech else ops.plain_op("IP_ADDRESS"))},
        ),
        "DEFAULT": OperatorConfig("replace", {"new_value": "[REDACTED]"}),
    }

    result = AnonymizerEngine().anonymize(text=text, analyzer_results=results, operators=operators)

    Path(args.out).write_text(result.text, encoding="utf-8")
    if ops.new_pseudonyms:
        mappings_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=1), encoding="utf-8")

    report = {
        "total": len(ops.findings),
        "counts": ops.counts,
        "findings": ops.findings,
        "unique_secret_count": len(ops.secret_raws),
        "pseudonyms_added": ops.new_pseudonyms,
    }
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"total": report["total"], "counts": ops.counts,
                      "unique_secret_count": report["unique_secret_count"],
                      "pseudonyms_added": len(ops.new_pseudonyms)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
