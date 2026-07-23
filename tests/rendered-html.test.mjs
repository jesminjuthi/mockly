import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { selectExamQuestions } from "../app/exam-selection.ts";
import { extractAnswerKeyMap, inferChapterLabel, isPdfSectionHeading, pdfItemsToVisualLines, removeRepeatedPageFurniture, stripEmbeddedAnswerSection, stripKnownPageFurniture } from "../app/pdf-cleanup.ts";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Mockly application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Mockly/);
  assert.match(html, /Mockly/);
  assert.match(html, /PDF/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("persists data on-device and removes the starter preview", async () => {
  const [page, storage, layout, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/device-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /cacheMethod:\s*"none"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(storage, /indexedDB\.open/);
  assert.match(page, /loadDeviceRecord/);
  assert.match(page, /saveDeviceRecord/);
  assert.match(page, /const SUBJECTS = \[/);
  assert.match(layout, /lang="bn"/);
  const hostingConfig = JSON.parse(hosting);
  assert.equal(hostingConfig.d1, null);
  assert.equal(hostingConfig.r2, null);
  assert.match(hostingConfig.project_id, /^appgprj_/);
  assert.match(packageJson, /"pdfjs-dist"/);
  assert.match(packageJson, /"tesseract\.js"/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  await assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
});

test("removes PDF headers and footers without changing the option", () => {
  assert.equal(
    stripKnownPageFurniture("promise The Contract Act, 1872 — Line-by-Line MCQ Bank (ICAB) 1"),
    "promise",
  );
  assert.equal(
    stripEmbeddedAnswerSection("False <details> <summary>Answer key — Section 1/summary>1-b, 2-b, 3-c</details>"),
    "False",
  );
  assert.equal(
    stripEmbeddedAnswerSection("False c, 6-b, 7-c, 8-a, 9-b, 10-c, 11-b, 12-c, 13-a, 14-b"),
    "False",
  );
  assert.equal(stripEmbeddedAnswerSection("6-b, 7-c, 8-a, 9-b"), "");
  assert.equal(inferChapterLabel("4th chapter laws N1.pdf"), "Chapter 4");
  assert.equal(inferChapterLabel("Business Law Chapter 7.pdf"), "Chapter 7");
  assert.equal(
    stripKnownPageFurniture("c) creates no right or obligation The Contract Act, 1872 — Line-by-Line MCQ Bank (ICAB) — Set 2 8"),
    "c) creates no right or obligation",
  );
  assert.deepEqual(
    removeRepeatedPageFurniture([
      ["Repeated book header", "1. First question?", "Page 1"],
      ["Repeated book header", "2. Second question?", "Page 2"],
    ]),
    [["1. First question?"], ["2. Second question?"]],
  );
});

test("keeps PDF section headings and source references out of answer options", () => {
  assert.equal(
    stripEmbeddedAnswerSection("When the risk is transferred 24.1 Contract of sale"),
    "When the risk is transferred",
  );
  assert.equal(
    stripEmbeddedAnswerSection(
      "False Source reference: supplied ICAB 2024 scan, PDF page 3. 24.1-24.2 Sale and formalities",
    ),
    "False",
  );
  assert.equal(
    stripEmbeddedAnswerSection("One created by a third-party valuation 24.3 Subject-matter of contract"),
    "One created by a third-party valuation",
  );
  assert.equal(stripEmbeddedAnswerSection("False 24.4.1 Ascertainment of price"), "False");
  assert.equal(
    stripEmbeddedAnswerSection(
      "the circumstances of the particular case Source reference: supplied ICAB 2024 scan, PDF page 4. 24.4.2 Sale at valuation",
    ),
    "the circumstances of the particular case",
  );
  for (const heading of [
    "24.1 Contract of sale",
    "24.1-24.2 Sale and formalities",
    "24.3 Subject-matter of contract",
    "24.4.1 Ascertainment of price",
    "24.4.2 Sale at valuation",
  ]) {
    assert.equal(isPdfSectionHeading(heading), true);
  }
  assert.equal(isPdfSectionHeading("24. What is a contract of sale?"), false);
});

test("recovers answer keys split between a number and its answer letter", () => {
  const answerMap = extractAnswerKeyMap([
    "<details><summary>Answer key — Section 1/summary>1-b, 2-b, 3-c, 4-b, 5",
    "c, 6-b, 7-c, 8-a, 9-b, 10-c, 11-b, 12-c, 13-a, 14-b</details>",
    "<details><summary>Answer key — Section 2/summary>15-c, 16-b, 17-d, 18",
    "b, 19-b, 20-a, 21-b, 22-d, 23-b</details>",
    "<details><summary>Answer key — Section 5/summary>60-b, 61-b, 62",
    "d</details>",
  ]);
  assert.equal(answerMap.size, 26);
  assert.deepEqual(answerMap.get("5"), [2]);
  assert.deepEqual(answerMap.get("18"), [1]);
  assert.deepEqual(answerMap.get("62"), [3]);
});

test("reads consolidated answer tables with source-style question keys", () => {
  const answerMap = extractAnswerKeyMap([
    "Part II - Consolidated answer section",
    "All 203 answers appear here, after the complete question portion.",
    "Question Correct answer",
    "P2-Q1 C. a buyer",
    "P2-Q2 A. A voluntary change of possession",
    "P18-Q7 D. do not apply",
  ]);
  assert.equal(answerMap.size, 3);
  assert.deepEqual(answerMap.get("P2-Q1"), [2]);
  assert.deepEqual(answerMap.get("P2-Q2"), [0]);
  assert.deepEqual(answerMap.get("P18-Q7"), [3]);
});

test("rebuilds two-column PDF answer rows from text coordinates", () => {
  const visualLines = pdfItemsToVisualLines([
    { str: "B. 1, 2 and 3", transform: [1, 0, 0, 1, 156, 661] },
    { str: "D. No", transform: [1, 0, 0, 1, 156, 642] },
    { str: "P17-Q1", transform: [1, 0, 0, 1, 97, 661] },
    { str: "P17-Q2", transform: [1, 0, 0, 1, 97, 642] },
  ]);
  assert.deepEqual(visualLines, ["P17-Q1 B. 1, 2 and 3", "P17-Q2 D. No"]);
  const answerMap = extractAnswerKeyMap(["Part II - Consolidated answer section", ...visualLines]);
  assert.deepEqual(answerMap.get("P17-Q1"), [1]);
  assert.deepEqual(answerMap.get("P17-Q2"), [3]);
});

test("selects questions from combined banks or by individual bank rules", () => {
  const questions = [
    ...Array.from({ length: 12 }, (_, order) => ({ id: `a-${order}`, sourceId: "bank-a", order })),
    ...Array.from({ length: 25 }, (_, order) => ({ id: `b-${order}`, sourceId: "bank-b", order })),
  ];
  const combined = selectExamQuestions({
    questions,
    sourceIds: ["bank-a", "bank-b"],
    mode: "combined",
    totalCount: 15,
    randomOrder: false,
    sourceRules: {},
  });
  assert.deepEqual(combined.map((question) => question.id), [
    "a-0", "b-0",
    "a-1", "b-1",
    "a-2", "b-2",
    "a-3", "b-3",
    "a-4", "b-4",
    "a-5", "b-5",
    "a-6", "b-6",
    "a-7",
  ]);

  const combinedRandom = selectExamQuestions({
    questions,
    sourceIds: ["bank-a", "bank-b"],
    mode: "combined",
    totalCount: 10,
    randomOrder: true,
    sourceRules: {},
    random: () => 0,
  });
  assert.equal(combinedRandom.filter((question) => question.sourceId === "bank-a").length, 5);
  assert.equal(combinedRandom.filter((question) => question.sourceId === "bank-b").length, 5);

  const individual = selectExamQuestions({
    questions,
    sourceIds: ["bank-a", "bank-b"],
    mode: "individual",
    totalCount: 99,
    randomOrder: true,
    sourceRules: {
      "bank-a": { count: 10, randomOrder: false },
      "bank-b": { count: 20, randomOrder: false },
    },
  });
  assert.equal(individual.length, 30);
  assert.deepEqual(individual.slice(0, 10).map((question) => question.id), Array.from({ length: 10 }, (_, order) => `a-${order}`));
  assert.deepEqual(individual.slice(10).map((question) => question.id), Array.from({ length: 20 }, (_, order) => `b-${order}`));
});

test("includes custom subject menus, safe bank deletion, and the requested footer credit", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /library-subject-filter/);
  assert.match(page, /chapter-input/);
  assert.match(page, /Developed with/);
  assert.match(page, /Jesmin Juthi/);
  assert.match(page, /function ThemedSelect/);
  assert.match(page, /aria-haspopup="listbox"/);
  assert.match(page, /setBankToDelete\(bank\)/);
  assert.match(page, /aria-labelledby="delete-bank-title"/);
  assert.match(page, /আবার প্রসেস করে আপডেট হয়েছে/);
  assert.match(page, /handleFileSelection/);
  assert.match(page, /openFilePicker\(bank\)/);
  assert.match(page, /আবার পড়ুন/);
  assert.match(page, /chooseBetterQuestionSet/);
  assert.match(page, /visualQuestions/);
  assert.match(page, /সব PDF মিলিয়ে/);
  assert.match(page, /PDF অনুযায়ী আলাদা/);
  assert.match(page, /selectExamQuestions/);
  assert.match(styles, /\.themed-select-menu/);
  assert.match(styles, /\.bank-rule/);
  assert.match(styles, /\.select-chevron::after/);
  assert.match(styles, /::selection\s*\{[^}]*background:\s*var\(--green\)[^}]*color:\s*#ffffff/si);
});

test("includes a GitHub Pages static build and deployment workflow", async () => {
  const [page, layout, nextConfig, workflow, guide, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../GITHUB-PAGES-BN.md", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(nextConfig, /output:\s*"export"/);
  assert.match(nextConfig, /NEXT_PUBLIC_BASE_PATH/);
  assert.match(page, /PUBLIC_BASE_PATH.*pdf\.worker\.min\.mjs/s);
  assert.match(layout, /NEXT_PUBLIC_SITE_URL/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(guide, /GitHub Pages/);
  assert.match(packageJson, /"build:pages":\s*"next build"/);
});
