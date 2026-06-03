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
  noteLabel: (note: string) => string; // frame around a degraded-retrieval note
  // prompts
  emptyStateHint: string;
  gettingStartedSeeded: (count: number) => string;
  gettingStartedTools: string;
  gettingStartedAuthNote: string;
  assessChangeEmpty: (area: string) => string;
  assessChangeSteps: (area: string) => string;
  // cli
  noBehaviorsYet: string;
  alreadySeeded: string;
  seeded: (n: number) => string;
  fed: (behaviors: number, rules: number, embeddings: number) => string;
  embedderUnavailable: string;
  usage: string;
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
  noteLabel: (note) => `⚠ Note: ${note}`,
  emptyStateHint: [
    "qa-memory is empty — nothing has been remembered yet.",
    "",
    "Feed it knowledge first, then query:",
    "  • add_to_memory — paste a spec, notes, or a page you fetched; it is extracted into behaviors + rules.",
    "  • update_rule — state a rule in your own words (QA voice), e.g. \"checkout must lock the cart on payment\".",
    "",
    "Once something is in, query_behavior and query_risk start returning real answers.",
  ].join("\n"),
  gettingStartedSeeded: (count) =>
    `qa-memory currently knows ${count} behavior${count === 1 ? "" : "s"}. ` +
    "Use query_behavior to recall product understanding, or query_risk before deciding test depth for a change.",
  gettingStartedTools: [
    "You are working with qa-memory — a QA knowledge layer that stores PRODUCT UNDERSTANDING (behaviors + rules), not test cases.",
    "",
    "Tools:",
    "  • add_to_memory — remember raw text (specs, notes, fetched pages).",
    "  • update_rule — pin a rule in QA voice (authoritative).",
    "  • query_behavior — recall what the product does.",
    "  • query_risk — derive a risk score for an area before testing it.",
  ].join("\n"),
  gettingStartedAuthNote:
    "For auth'd sources (Jira/Confluence/Drive), fetch with your own connected tools first, then pass the text to add_to_memory.",
  assessChangeEmpty: (area) => `Then come back and assess "${area}".`,
  assessChangeSteps: (area) =>
    [
      `A change is coming to: "${area}".`,
      "",
      "Do this:",
      `  1. Call query_risk with "${area}" to get the derived risk score, matched behaviors, and their rules.`,
      "  2. Read the reasons behind the score — they tell you where the danger is.",
      "  3. If a rule is missing or wrong, fix it with update_rule (QA voice) so the memory improves.",
      "  4. Focus test depth on the highest-criticality behaviors surfaced.",
    ].join("\n"),
  noBehaviorsYet: "No behaviors yet. Run `qa-memory seed` for dogfood data.",
  alreadySeeded: "DB already has behaviors; nothing seeded.",
  seeded: (n) => `Seeded ${n} behaviors.`,
  fed: (behaviors, rules, embeddings) =>
    `fed: ${behaviors} behaviors, ${rules} rules, ${embeddings} embeddings`,
  embedderUnavailable: "(embedder unavailable → LIKE-only search)",
  usage: [
    "Usage: qa-memory <command>",
    "  status           show DB path + row counts",
    "  list behaviors   list known behaviors",
    "  seed             insert dogfood behaviors (no-op if any exist)",
    "  feed             read structured knowledge JSON from stdin and persist it",
    "                   (no-LLM: caller is the extractor; local embeddings added)",
  ].join("\n"),
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
  noteLabel: (note) => `⚠ Nota: ${note}`,
  emptyStateHint: [
    "qa-memory está vazio — nada foi lembrado ainda.",
    "",
    "Alimente com conhecimento primeiro, depois consulte:",
    "  • add_to_memory — cole uma spec, notas ou uma página que você buscou; será extraído em behaviors + regras.",
    "  • update_rule — declare uma regra com suas próprias palavras (voz do QA), ex.: \"checkout deve bloquear o carrinho no pagamento\".",
    "",
    "Com algo dentro, query_behavior e query_risk começam a retornar respostas reais.",
  ].join("\n"),
  gettingStartedSeeded: (count) =>
    `qa-memory conhece atualmente ${count} behavior${count === 1 ? "" : "s"}. ` +
    "Use query_behavior para recuperar o entendimento do produto, ou query_risk antes de decidir a profundidade de testes para uma mudança.",
  gettingStartedTools: [
    "Você está trabalhando com qa-memory — uma camada de conhecimento de QA que armazena ENTENDIMENTO DO PRODUTO (behaviors + regras), não casos de teste.",
    "",
    "Ferramentas:",
    "  • add_to_memory — lembrar texto bruto (specs, notas, páginas buscadas).",
    "  • update_rule — fixar uma regra na voz do QA (autoritativa).",
    "  • query_behavior — recuperar o que o produto faz.",
    "  • query_risk — derivar um score de risco para uma área antes de testá-la.",
  ].join("\n"),
  gettingStartedAuthNote:
    "Para fontes autenticadas (Jira/Confluence/Drive), busque com suas próprias ferramentas conectadas primeiro, depois passe o texto para add_to_memory.",
  assessChangeEmpty: (area) => `Depois volte e avalie "${area}".`,
  assessChangeSteps: (area) =>
    [
      `Uma mudança está chegando em: "${area}".`,
      "",
      "Faça isso:",
      `  1. Chame query_risk com "${area}" para obter o score de risco derivado, behaviors correspondentes e suas regras.`,
      "  2. Leia as razões por trás do score — elas dizem onde está o perigo.",
      "  3. Se uma regra estiver faltando ou errada, corrija com update_rule (voz do QA) para a memória melhorar.",
      "  4. Concentre a profundidade de testes nos behaviors de maior criticidade encontrados.",
    ].join("\n"),
  noBehaviorsYet: "Nenhum behavior ainda. Execute `qa-memory seed` para dados de exemplo.",
  alreadySeeded: "DB já tem behaviors; nada foi semeado.",
  seeded: (n) => `Semeados ${n} behaviors.`,
  fed: (behaviors, rules, embeddings) =>
    `alimentado: ${behaviors} behaviors, ${rules} regras, ${embeddings} embeddings`,
  embedderUnavailable: "(embedder indisponível → busca só por LIKE)",
  usage: [
    "Uso: qa-memory <comando>",
    "  status           exibe caminho do DB + contagem de linhas",
    "  list behaviors   lista behaviors conhecidos",
    "  seed             insere behaviors de exemplo (sem efeito se já existirem)",
    "  feed             lê JSON de conhecimento estruturado do stdin e persiste",
    "                   (sem LLM: quem chama é o extrator; embeddings locais adicionados)",
  ].join("\n"),
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
