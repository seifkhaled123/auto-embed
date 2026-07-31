import { EvaluationResult, MetricSet } from "./types.js";

export function renderEvaluationHtml(result: EvaluationResult): string {
  const baseline = result.experiments.find((experiment) => experiment.id === result.baselineExperiment);
  if (!baseline) throw new Error(`Missing baseline experiment: ${result.baselineExperiment}`);
  const metricKeys: Array<keyof MetricSet> = ["hitRate", "recall", "precision", "mrr", "ndcg"];
  const metricLabels: Record<keyof MetricSet, string> = {
    hitRate: "Hit rate",
    recall: "Recall@K",
    precision: "Precision@K",
    mrr: "MRR",
    ndcg: "nDCG",
  };
  const experimentCards = result.experiments.map((experiment, index) => `
    <article class="experiment ${experiment.id === result.baselineExperiment ? "baseline" : ""}" style="--delay:${index * 80}ms">
      <header><span>EXP ${String(index + 1).padStart(2, "0")}</span><b>${escapeHtml(experiment.id)}</b></header>
      <p>${escapeHtml(experiment.splitter)} · ${experiment.chunkSize} tokens · ${experiment.overlap} overlap · ${experiment.chunkCount} chunks</p>
      <div class="bars">
        ${metricKeys.map((key) => `
          <div class="bar-row"><span>${metricLabels[key]}</span><i><b style="width:${percentage(experiment.metrics[key])}"></b></i><strong>${percentage(experiment.metrics[key])}</strong></div>
        `).join("")}
      </div>
    </article>
  `).join("");
  const queryRows = baseline.queries.map((query) => `
    <tr>
      <td><code>${escapeHtml(query.queryId)}</code></td>
      <td>${query.ranked[0] ? escapeHtml(query.ranked[0].source) : "—"}</td>
      <td>${query.metrics.hitRate ? "HIT" : "MISS"}</td>
      <td>${percentage(query.metrics.recall)}</td>
      <td>${percentage(query.metrics.mrr)}</td>
      <td>${percentage(query.metrics.ndcg)}</td>
    </tr>
  `).join("");
  const status = result.thresholdStatus === "pass"
    ? "REGRESSION GATE PASS"
    : result.thresholdStatus === "fail"
    ? "REGRESSION GATE FAIL"
    : "THRESHOLDS NOT CONFIGURED";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Deterministic auto-embed structural chunking evaluation report.">
  <title>auto-embed — Retrieval Quality Lab</title>
  <style>
    :root{--black:#10110e;--panel:#191b16;--grid:#30342a;--paper:#e9e5d8;--acid:#d9ff49;--amber:#ffad32;--red:#ff5d47;--muted:#a9aa9d;--mono:"IBM Plex Mono","Courier New",monospace;--display:"Avenir Next Condensed","Franklin Gothic Medium","Arial Narrow",sans-serif;--serif:"Bodoni 72",Didot,Georgia,serif}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--paper);background:linear-gradient(rgba(217,255,73,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(217,255,73,.035) 1px,transparent 1px),var(--black);background-size:24px 24px;font:15px/1.55 var(--mono)}::selection{color:var(--black);background:var(--acid)}
    .top{display:flex;justify-content:space-between;gap:2rem;padding:1rem clamp(1rem,4vw,4rem);border-bottom:1px solid var(--grid);font-size:.7rem;letter-spacing:.12em;text-transform:uppercase}.top b{color:var(--acid)}
    .hero{position:relative;overflow:hidden;display:grid;grid-template-columns:1.25fr .75fr;gap:4rem;align-items:end;min-height:560px;padding:clamp(4rem,9vw,8rem) clamp(1rem,7vw,7rem);border-bottom:8px solid var(--acid)}.hero:before{content:"IR";position:absolute;right:-.05em;top:-.25em;color:rgba(217,255,73,.055);font:900 35rem/1 var(--display)}.hero>*{position:relative}.eyebrow{margin:0 0 1rem;color:var(--acid);font-weight:800;letter-spacing:.14em;text-transform:uppercase}.hero h1{max-width:9ch;margin:0;font:400 clamp(4rem,9vw,9rem)/.78 var(--serif);letter-spacing:-.055em}.hero h1 em{color:var(--acid)}.hero p{max-width:60ch}.verdict{padding:1.5rem;color:var(--black);background:var(--acid);border:3px solid var(--paper);box-shadow:10px 10px 0 var(--amber);transform:rotate(1deg)}.verdict small{display:block;font-weight:900;letter-spacing:.12em}.verdict strong{display:block;margin:.5rem 0;font:900 clamp(2rem,4vw,4rem)/.9 var(--display)}
    main{width:min(1180px,calc(100% - 2rem));margin:auto}.section{padding:6rem 0;border-bottom:1px solid var(--grid)}.section-head{display:grid;grid-template-columns:1fr .7fr;gap:3rem;align-items:end;margin-bottom:2.5rem}.section h2{margin:0;font:900 clamp(2.5rem,5vw,5rem)/.9 var(--display);text-transform:uppercase}.section-head p{margin:0;color:var(--muted)}
    .score-strip{display:grid;grid-template-columns:repeat(5,1fr);border:2px solid var(--paper)}.score{padding:1.25rem;border-right:1px solid var(--paper)}.score:last-child{border:0}.score span{display:block;color:var(--muted);font-size:.68rem;text-transform:uppercase}.score b{display:block;color:var(--acid);font:900 2.4rem/1 var(--display)}
    .experiments{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem}.experiment{padding:1.25rem;background:var(--panel);border:1px solid var(--grid);animation:rise .5s both;animation-delay:var(--delay)}.experiment.baseline{border:2px solid var(--acid);box-shadow:6px 6px 0 var(--acid)}.experiment header{display:flex;justify-content:space-between;gap:1rem;color:var(--amber);font-size:.68rem}.experiment header b{color:var(--paper)}.experiment p{min-height:3.5rem;color:var(--muted);font-size:.75rem}.bars{display:grid;gap:.65rem}.bar-row{display:grid;grid-template-columns:72px 1fr 46px;gap:.6rem;align-items:center;font-size:.65rem}.bar-row i{height:8px;background:var(--grid)}.bar-row i b{display:block;height:100%;background:var(--acid)}.bar-row strong{text-align:right}
    .table-wrap{overflow:auto;border:1px solid var(--grid)}table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{padding:.85rem 1rem;text-align:left;border-bottom:1px solid var(--grid)}th{color:var(--amber);font-size:.66rem;letter-spacing:.08em;text-transform:uppercase}td:nth-child(3){color:var(--acid);font-weight:900}code{color:var(--paper)}
    .method{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}.method article{padding:1.25rem;border-top:4px solid var(--amber);background:var(--panel)}.method h3{margin:0;font:900 1.25rem var(--display);text-transform:uppercase}.method p{color:var(--muted);font-size:.8rem}
    footer{display:flex;justify-content:space-between;gap:1rem;padding:2rem clamp(1rem,4vw,4rem);color:var(--muted);font-size:.65rem;text-transform:uppercase}@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
    @media(max-width:850px){.hero,.section-head{grid-template-columns:1fr}.score-strip{grid-template-columns:repeat(2,1fr)}.experiments,.method{grid-template-columns:1fr}.hero:before{font-size:20rem}}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}
    @media print{body{color:#111;background:#fff}.top{color:#111}.hero{min-height:auto;color:#111}.hero h1 em{color:#111}.section{padding:2rem 0}.experiment,.method article,table{color:#111;background:#fff}.experiment.baseline{box-shadow:none}.score-strip{border-color:#111}.score{border-color:#111}.score b{color:#111}}
  </style>
</head>
<body>
  <header class="top"><span>auto-embed / retrieval quality lab</span><b>${escapeHtml(status)}</b><span>${escapeHtml(result.manifestHash.slice(0, 12))}</span></header>
  <section class="hero">
    <div><p class="eyebrow">Offline ingestion experiment · deterministic</p><h1>Measure the <em>index.</em></h1><p>${escapeHtml(result.name)} compares parser/chunker settings with a private lexical TF-IDF retrieval backend. It is an engineering gate, not a product query API.</p></div>
    <aside class="verdict"><small>BASELINE / ${escapeHtml(result.baselineExperiment)}</small><strong>${percentage(baseline.metrics.hitRate)} HIT RATE</strong><span>${baseline.chunkCount} chunks · top ${result.topK}</span></aside>
  </section>
  <main>
    <section class="section"><div class="section-head"><h2>Baseline signal</h2><p>Macro averages over the versioned golden queries. Precision uses the fixed top-K denominator; all other metrics use binary chunk relevance.</p></div><div class="score-strip">${metricKeys.map((key)=>`<div class="score"><span>${metricLabels[key]}</span><b>${percentage(baseline.metrics[key])}</b></div>`).join("")}</div></section>
    <section class="section"><div class="section-head"><h2>Strategy sweep</h2><p>Structural strategies only. Semantic and contextual splitters remain gated until a measured corpus shows that their cost and determinism trade-offs are justified.</p></div><div class="experiments">${experimentCards}</div></section>
    <section class="section"><div class="section-head"><h2>Golden queries</h2><p>Baseline per-query outcomes make misses inspectable instead of hiding them inside one aggregate score.</p></div><div class="table-wrap"><table><thead><tr><th>Query</th><th>Top source</th><th>Hit@K</th><th>Recall</th><th>MRR</th><th>nDCG</th></tr></thead><tbody>${queryRows}</tbody></table></div></section>
    <section class="section"><div class="section-head"><h2>Method ledger</h2><p>The report is self-contained and reproducible from the committed manifest and fixtures.</p></div><div class="method"><article><h3>Backend</h3><p>${escapeHtml(result.backend)} uses lowercase Unicode terms, a fixed stop-word list, TF-IDF weighting, cosine similarity, and chunk-ID tie breaks. No network or provider key.</p></article><article><h3>Labels</h3><p>Each query names an expected source and exact supporting phrase. Relevant chunk IDs are derived after each experiment chunks the corpus.</p></article><article><h3>Boundary</h3><p>No query command, reranker, generation path, or serving API is included in the production bundle. This evaluator exists only under test engineering.</p></article></div></section>
  </main>
  <footer><span>Evaluator v${result.evaluatorVersion} · top ${result.topK}</span><span>Manifest ${escapeHtml(result.manifestHash)}</span></footer>
</body>
</html>`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
