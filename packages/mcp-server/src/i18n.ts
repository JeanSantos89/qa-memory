// Presentation-layer i18n. The LLM-extracted CONTENT already follows the input
// language (PT in → PT out); this module translates the FRAME around it — risk
// headers, section titles, the reasons[] sentences, the rendered labels — which
// were hardcoded English (debt logged in STATE). No dep, no schema.
//
// Language is chosen by QA_MEMORY_LANG (default "en"; "pt-BR" / "pt" map to
// Portuguese). Unknown values fall back to English. Adding a language = one new
// Labels object; the keys are the contract.

export type Lang = "en" | "pt-BR";

export interface Labels {
  // query_risk frame
  riskHeader: (level: string, score: string, query: string, via: string) => string;
  resolvedViaArea: string; // appended to header when an area resolved the path
  noKnownRules: string;
  ruleTag: (kind: "qa" | "inferred", confidence: string) => string;
  brokeLabel: (title: string, severity: string, ref: string) => string;
  noBehaviorMatch: (query: string) => string;
  // risk reasons[]
  reasonNoCoverage: string;
  reasonHighestCriticality: (criticality: string, name: string) => string;
  reasonUnconfirmed: (n: number) => string;
  reasonNoRules: (n: number) => string;
  reasonAllInferred: string;
  reasonIncidents: (n: number, addend: string, capped: boolean) => string;
  // analyze_impact frame
  impactHeader: (change: string) => string;
  sectionMayBreak: string;
  sectionWatch: string;
  sectionConflicts: string;
  none: string;
  reasonedOver: (n: number, tokens: number) => string;
}

const EN: Labels = {
  riskHeader: (level, score, query, via) => `Risk: ${level} (${score}) for "${query}"${via}`,
  resolvedViaArea: " [resolved via mapped area]",
  noKnownRules: "(no known rules)",
  ruleTag: (kind, confidence) => `${kind === "qa" ? "QA" : "inferred"} ${confidence}`,
  brokeLabel: (title, severity, ref) => `broke: ${title}${severity}${ref}`,
  noBehaviorMatch: (query) => `No behaviors match "${query}".`,
  reasonNoCoverage: "No known behavior matches this area — qa-memory has no coverage here.",
  reasonHighestCriticality: (criticality, name) =>
    `Highest criticality at stake: ${criticality} (${name}).`,
  reasonUnconfirmed: (n) => `${n} matched behavior(s) not yet confirmed by QA.`,
  reasonNoRules: (n) => `${n} matched behavior(s) have no known rules (knowledge gap).`,
  reasonAllInferred: "All known rules are low-confidence inferences (none QA-confirmed).",
  reasonIncidents: (n, addend, capped) =>
    `${n} recorded incident(s) here — what already broke (+${addend}${capped ? " (capped)" : ""}).`,
  impactHeader: (change) => `Impact of: "${change}"`,
  sectionMayBreak: "MAY BREAK",
  sectionWatch: "WATCH WHEN TESTING",
  sectionConflicts: "CONFLICTS",
  none: "(none)",
  reasonedOver: (n, tokens) =>
    `(reasoned over ${n} related rule${n === 1 ? "" : "s"}, ${tokens} tokens)`,
};

const PT_BR: Labels = {
  riskHeader: (level, score, query, via) => `Risco: ${level} (${score}) para "${query}"${via}`,
  resolvedViaArea: " [resolvido via área mapeada]",
  noKnownRules: "(sem regras conhecidas)",
  ruleTag: (kind, confidence) => `${kind === "qa" ? "QA" : "inferida"} ${confidence}`,
  brokeLabel: (title, severity, ref) => `quebrou: ${title}${severity}${ref}`,
  noBehaviorMatch: (query) => `Nenhum behavior corresponde a "${query}".`,
  reasonNoCoverage:
    "Nenhum behavior conhecido cobre esta área — qa-memory não tem cobertura aqui.",
  reasonHighestCriticality: (criticality, name) =>
    `Maior criticidade em jogo: ${criticality} (${name}).`,
  reasonUnconfirmed: (n) => `${n} behavior(s) correspondentes ainda não confirmados pelo QA.`,
  reasonNoRules: (n) =>
    `${n} behavior(s) correspondentes sem regras conhecidas (lacuna de conhecimento).`,
  reasonAllInferred:
    "Todas as regras conhecidas são inferências de baixa confiança (nenhuma confirmada pelo QA).",
  reasonIncidents: (n, addend, capped) =>
    `${n} incidente(s) registrado(s) aqui — o que já quebrou (+${addend}${capped ? " (limitado)" : ""}).`,
  impactHeader: (change) => `Impacto de: "${change}"`,
  sectionMayBreak: "PODE QUEBRAR",
  sectionWatch: "ATENÇÃO AO TESTAR",
  sectionConflicts: "CONFLITOS",
  none: "(nenhum)",
  reasonedOver: (n, tokens) =>
    `(analisado sobre ${n} regra${n === 1 ? "" : "s"} relacionada${n === 1 ? "" : "s"}, ${tokens} tokens)`,
};

const TABLE: Record<Lang, Labels> = { en: EN, "pt-BR": PT_BR };

// Normalizes an env value to a supported Lang. "pt", "pt-br", "pt_BR" → pt-BR;
// anything else → en.
export function normalizeLang(raw: string | undefined): Lang {
  const v = raw?.trim().toLowerCase().replace("_", "-");
  if (v === "pt" || v === "pt-br") return "pt-BR";
  return "en";
}

export function getLabels(env: NodeJS.ProcessEnv = process.env): Labels {
  return TABLE[normalizeLang(env.QA_MEMORY_LANG)];
}
