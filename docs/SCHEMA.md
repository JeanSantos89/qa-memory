# SCHEMA — fonte de verdade do SQLite

> Living doc. Schema espelhado em DOIS packages (mcp-server TS + ingestion Python).
> Toda migration → atualizar este arquivo no MESMO commit (pre-commit hook bloqueia se não).

## Status
- **Migrations implementadas:** nenhuma ainda (Fase 1 cria as tabelas).
- Abaixo: schema-alvo definido na spec. Vira realidade na Fase 1.

## Tabelas (alvo)

### behaviors
Comportamentos do produto. Unidade central.
| coluna | tipo | notas |
|--------|------|-------|
| id | TEXT PK | uuid v4 |
| name | TEXT NOT NULL | |
| description | TEXT NOT NULL | |
| criticality | TEXT NOT NULL | P0\|P1\|P2\|P3\|custom |
| status | TEXT NOT NULL DEFAULT 'active' | active\|deprecated\|under_review |
| source_ids | TEXT NOT NULL DEFAULT '[]' | JSON array |
| confirmed_by_qa | INTEGER NOT NULL DEFAULT 0 | 0=inferido, 1=confirmado |
| qa_note | TEXT | |
| created_at / updated_at | TEXT NOT NULL | ISO8601 |

### rules
Regras de negócio associadas a behaviors.
| coluna | tipo | notas |
|--------|------|-------|
| id | TEXT PK | |
| behavior_id | TEXT NOT NULL → behaviors(id) | |
| rule_text | TEXT NOT NULL | |
| confidence | REAL NOT NULL DEFAULT 0.7 | 0.0–1.0 |
| source_excerpt | TEXT | |
| source_id | TEXT | |
| qa_override | INTEGER NOT NULL DEFAULT 0 | 1=QA definiu, sobrescreve inferência |
| override_reason | TEXT | |
| created_at / updated_at | TEXT NOT NULL | |

### areas
Mapeamento arquivos/módulos ↔ behaviors.
| coluna | tipo | notas |
|--------|------|-------|
| id | TEXT PK | |
| file_pattern | TEXT NOT NULL | glob |
| behavior_ids | TEXT NOT NULL | JSON array |
| notes | TEXT | |
| created_at | TEXT NOT NULL | |

### incidents
Histórico de bugs/falhas por behavior.
| coluna | tipo | notas |
|--------|------|-------|
| id | TEXT PK | |
| behavior_id | TEXT NOT NULL → behaviors(id) | |
| title | TEXT NOT NULL | |
| description | TEXT | |
| severity | TEXT | P0\|P1\|P2\|P3 |
| source_type | TEXT | jira\|manual\|ci_failure |
| source_ref | TEXT | ex PROJ-3053, URL |
| occurred_at | TEXT | |
| created_at | TEXT NOT NULL | |

### sources
Documentos e integrações configuradas.
| coluna | tipo | notas |
|--------|------|-------|
| id | TEXT PK | |
| type | TEXT NOT NULL | pdf\|google_doc\|jira\|confluence\|notion\|har\|conversation |
| label | TEXT NOT NULL | |
| source_ref | TEXT NOT NULL | path/URL/ID/query |
| last_synced | TEXT | |
| sync_status | TEXT | success\|failed\|pending |
| sync_error | TEXT | |
| checksum | TEXT | evita reprocessar iguais |
| created_at / updated_at | TEXT NOT NULL | |

### embeddings
Vetores p/ similarity search local.
| coluna | tipo | notas |
|--------|------|-------|
| id | TEXT PK | |
| entity_type | TEXT NOT NULL | behavior\|rule\|incident |
| entity_id | TEXT NOT NULL | |
| content | TEXT NOT NULL | texto embedado |
| vector | BLOB NOT NULL | float array serializado |
| model | TEXT NOT NULL | |
| created_at | TEXT NOT NULL | |

## Modelo de confiança (confidence)
| origem | confidence inicial | qa_override |
|--------|-------------------|-------------|
| PDF/doc via LLM | 0.5–0.8 | 0 |
| Jira Bug | 0.85 | 0 |
| Jira Story/Epic | 0.6 | 0 |
| QA confirm | 1.0 | 0 |
| QA override | 1.0 | 1 |

Regras com confidence < 0.5 → status `under_review`, não retornadas pelo MCP até confirmação.
