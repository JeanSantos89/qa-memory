import { describe, expect, it } from "vitest";
import { getLabels, normalizeLang } from "./i18n.js";

describe("normalizeLang", () => {
  it("maps pt variants to pt-BR", () => {
    expect(normalizeLang("pt")).toBe("pt-BR");
    expect(normalizeLang("pt-BR")).toBe("pt-BR");
    expect(normalizeLang("pt_BR")).toBe("pt-BR");
    expect(normalizeLang("PT-br")).toBe("pt-BR");
  });

  it("falls back to en for unknown/empty", () => {
    expect(normalizeLang(undefined)).toBe("en");
    expect(normalizeLang("")).toBe("en");
    expect(normalizeLang("fr")).toBe("en");
  });
});

describe("getLabels", () => {
  it("returns English frame by default", () => {
    const L = getLabels({});
    expect(L.sectionMayBreak).toBe("MAY BREAK");
    expect(L.riskHeader("HIGH", "0.90", "checkout", "")).toContain("Risk: HIGH");
    expect(L.noteLabel("limited")).toContain("Note:");
  });

  it("returns Portuguese frame when QA_MEMORY_LANG=pt-BR", () => {
    const L = getLabels({ QA_MEMORY_LANG: "pt-BR" });
    expect(L.sectionMayBreak).toBe("PODE QUEBRAR");
    expect(L.riskHeader("HIGH", "0.90", "checkout", "")).toContain("Risco: HIGH");
    expect(L.reasonNoCoverage).toContain("não tem cobertura");
    expect(L.noteLabel("limitada")).toContain("Nota:");
  });

  it("prompt titles are localized", () => {
    const en = getLabels({});
    expect(en.promptGettingStartedTitle).toContain("Getting started");
    expect(en.promptAssessChangeTitle).toContain("Assess");

    const pt = getLabels({ QA_MEMORY_LANG: "pt-BR" });
    expect(pt.promptGettingStartedTitle).toContain("Primeiros passos");
    expect(pt.promptAssessChangeTitle).toContain("Avaliar");
  });

  it("feedInvalidJson is localized", () => {
    expect(getLabels({}).feedInvalidJson("oops")).toContain("invalid JSON");
    expect(getLabels({ QA_MEMORY_LANG: "pt-BR" }).feedInvalidJson("oops")).toContain("inválido");
  });
});
