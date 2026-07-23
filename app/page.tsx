"use client";

import { ChangeEvent, DragEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { clearDeviceStorage, loadDeviceRecord, saveDeviceRecord } from "./device-storage";
import { BankSelectionRule, ExamSelectionMode, selectExamQuestions } from "./exam-selection";
import { compact, extractAnswerKeyMap, inferChapterLabel, isPageFurniture, isPdfSectionHeading, pdfItemsToLines, pdfItemsToVisualLines, removeRepeatedPageFurniture, stripEmbeddedAnswerSection, stripKnownPageFurniture } from "./pdf-cleanup";

const SUBJECTS = [
  "Business Laws",
  "Information Technology",
  "Principles of Taxation",
  "Accounting",
  "Management Information",
  "Assurance",
  "Business Finance and Technology",
] as const;

type Subject = (typeof SUBJECTS)[number];
type ImportMode = "text" | "ocr" | "manual";
type Screen = "library" | "setup" | "exam" | "result";

type Question = {
  id: string;
  sourceId: string;
  sourceName: string;
  subject: Subject;
  chapter: string;
  key: string;
  prompt: string;
  options: string[];
  correct: number[];
  explanation?: string;
  page?: number;
  order: number;
};

type Bank = {
  id: string;
  name: string;
  subject: Subject;
  chapter?: string;
  mode: ImportMode;
  pages?: number;
  questions: Question[];
};

type PendingOcr = {
  file: File;
  subject: Subject;
  chapter?: string;
  pages: number;
};

type ExamAnswer = Record<string, number[]>;

type SavedLibrary = { version: 1; banks: Bank[]; subject: Subject };
type SavedSettings = {
  version: 1;
  selectedBanks: string[];
  selectedChapters: string[];
  randomOrder: boolean;
  questionCount: number;
  selectionMode?: ExamSelectionMode;
  bankRules?: Record<string, BankSelectionRule>;
};
type SavedProgress = {
  version: 1;
  screen: Screen;
  examQuestionIds: string[];
  answers: ExamAnswer;
  currentIndex: number;
};

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeQuestion(question: Question): Question {
  return {
    ...question,
    prompt: stripEmbeddedAnswerSection(question.prompt),
    options: question.options.map(stripEmbeddedAnswerSection).filter(Boolean),
    explanation: question.explanation ? stripEmbeddedAnswerSection(question.explanation) || undefined : undefined,
  };
}

function sanitizeBanks(banks: Bank[]) {
  return banks.map((bank) => {
    const chapter = bank.chapter || inferChapterLabel(bank.name);
    return {
      ...bank,
      chapter: chapter || undefined,
      questions: bank.questions.map((question) => ({
        ...sanitizeQuestion(question),
        chapter: chapter || question.chapter,
      })),
    };
  });
}

function answerIndexes(value: string) {
  const matches = value.toUpperCase().match(/[A-F]/g) ?? [];
  return [...new Set(matches.map((letter) => LETTERS.indexOf(letter)).filter((n) => n >= 0))];
}

function isChapterHeading(line: string, nextLine = "") {
  if (/[?]/.test(line) || line.length > 95) return false;
  const numbered = /^(?:Chapter\s+)?\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z0-9 &/(),–—-]+$/i.test(line);
  const nextIsQuestion = /^(?:P\d+-Q\d+|\d+)\.?\s+(?:\[[^\]]+\]\s*)?\S+/i.test(nextLine);
  return numbered && nextIsQuestion;
}

function parseQuestionText(
  raw: string,
  source: { id: string; name: string; subject: Subject; chapter?: string },
  pageByLine?: number[],
  supplementalAnswerLines: string[] = [],
) {
  const rawLines = raw.replace(/\r/g, "").split("\n");
  const answerLines = rawLines.map(stripKnownPageFurniture);
  let insideEmbeddedAnswerDetails = false;
  let insideConsolidatedAnswerSection = false;
  const lines = answerLines.map((line) => {
    if (/Consolidated\s+answer\s+section/i.test(line)) insideConsolidatedAnswerSection = true;
    if (insideConsolidatedAnswerSection) return "";
    const startsDetails = /<\s*details\b/i.test(line);
    const endsDetails = /<\s*\/\s*details\s*>/i.test(line);
    if (insideEmbeddedAnswerDetails) {
      if (endsDetails) insideEmbeddedAnswerDetails = false;
      return "";
    }
    if (startsDetails && !endsDetails) insideEmbeddedAnswerDetails = true;
    return stripEmbeddedAnswerSection(line);
  });
  const answerMap = extractAnswerKeyMap([
    ...answerLines,
    ...supplementalAnswerLines.map(stripKnownPageFurniture),
  ]);

  type Draft = {
    key: string;
    prompt: string;
    options: string[];
    correct: number[];
    explanation: string;
    chapter: string;
    page?: number;
  };

  const parsed: Question[] = [];
  let current: Draft | null = null;
  let chapter = source.chapter || "সাধারণ";
  let inExplanation = false;
  let resetOptions = false;

  const finish = () => {
    if (!current) return;
    const prompt = stripEmbeddedAnswerSection(current.prompt);
    const options = current.options.map(stripEmbeddedAnswerSection).filter(Boolean);
    if (prompt.length >= 5 && options.length >= 2) {
      const key = current.key.toUpperCase();
      parsed.push({
        id: uid("q"),
        sourceId: source.id,
        sourceName: source.name,
        subject: source.subject,
        chapter: current.chapter,
        key,
        prompt,
        options: options.slice(0, 6),
        correct: current.correct.length ? current.correct : answerMap.get(key) ?? [],
        explanation: stripEmbeddedAnswerSection(current.explanation) || undefined,
        page: current.page,
        order: parsed.length,
      });
    }
    current = null;
    inExplanation = false;
    resetOptions = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const nextLine = lines.slice(index + 1).find(Boolean) ?? "";
    if (isPageFurniture(line)) continue;

    if (isPdfSectionHeading(line)) {
      finish();
      if (!source.chapter) chapter = line;
      continue;
    }

    if (!source.chapter && isChapterHeading(line, nextLine)) {
      finish();
      chapter = line.replace(/^(?:Chapter\s+)?\d+(?:\.\d+)*\.?\s*/i, "").trim() || line;
      continue;
    }

    const questionMatch = line.match(/^(P\d+-Q\d+|\d+)\.?\s+(?:\[[^\]]+\]\s*)?(.+)/i);
    if (questionMatch && !/^\d+\s*[-–—:]\s*[A-F]/i.test(line)) {
      finish();
      current = {
        key: questionMatch[1],
        prompt: questionMatch[2],
        options: [],
        correct: [],
        explanation: "",
        chapter,
        page: pageByLine?.[index],
      };
      continue;
    }

    if (!current) continue;
    const answerMatch = line.match(/^(?:Answer|Correct answer)\s*[:—–-]\s*(.+)$/i);
    if (answerMatch) {
      current.correct = answerIndexes(answerMatch[1]);
      inExplanation = false;
      continue;
    }
    const explanationMatch = line.match(/^Explanation\s*[:—–-]\s*(.*)$/i);
    if (explanationMatch) {
      current.explanation = explanationMatch[1];
      inExplanation = true;
      continue;
    }
    if (/^Correct answers are\s*[:—–-]?$/i.test(line)) {
      resetOptions = true;
      continue;
    }
    const optionMatch = line.match(/^([A-Fa-f])[.)]\s*(.+)$/);
    if (optionMatch && !inExplanation) {
      if (resetOptions || (optionMatch[1].toUpperCase() === "A" && current.options.length >= 2)) {
        current.options = [];
        resetOptions = false;
      }
      current.options.push(optionMatch[2]);
      continue;
    }
    if (inExplanation) current.explanation += ` ${line}`;
    else if (current.options.length) current.options[current.options.length - 1] += ` ${line}`;
    else current.prompt += ` ${line}`;
  }
  finish();
  return parsed;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function prepareExtractedPageTexts(pages: string[][]) {
  return removeRepeatedPageFurniture(pages).map((lines) =>
    lines
      .join("\n")
      .replace(/\s+([A-Fa-f][.)]\s)/g, "\n$1")
      .replace(/\s+((?:P\d+-Q\d+|\d+)\.\s)/g, "\n$1")
      .replace(/\s+(Answer(?: Key)?\s*[:—–-])/gi, "\n$1")
      .replace(/\s+(Explanation\s*[:—–-])/gi, "\n$1"),
  );
}

function chooseBetterQuestionSet(primary: Question[], visual: Question[]) {
  const rank = (questions: Question[]) => [
    questions.filter((question) => question.correct.length).length,
    questions.length,
    questions.reduce((total, question) => total + Math.min(question.options.length, 4), 0),
  ];
  const primaryRank = rank(primary);
  const visualRank = rank(visual);
  for (let index = 0; index < primaryRank.length; index += 1) {
    if (visualRank[index] > primaryRank[index]) return visual;
    if (visualRank[index] < primaryRank[index]) return primary;
  }
  return primary;
}

type ThemedSelectOption = { value: string; label: string };

function ThemedSelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
  ariaLabelledBy,
}: {
  id: string;
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact?: boolean;
  ariaLabelledBy: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] ?? options[0];

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

  const closeAndFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    optionRefs.current[nextIndex]?.focus();
  };

  return (
    <div ref={rootRef} className={`select-shell themed-select ${compact ? "compact-select" : ""} ${open ? "open" : ""}`}>
      <button
        ref={buttonRef}
        id={id}
        className="themed-select-button"
        type="button"
        aria-labelledby={`${ariaLabelledBy} ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span id={`${id}-value`}>{selectedOption?.label}</span>
        <i className="select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="themed-select-menu" role="listbox" aria-labelledby={ariaLabelledBy}>
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node; }}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`themed-select-option ${option.value === value ? "selected" : ""}`}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
              onClick={() => {
                onChange(option.value);
                closeAndFocus();
              }}
            >
              <span>{option.label}</span>
              <i aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("library");
  const [subject, setSubject] = useState<Subject>("Assurance");
  const [chapterInput, setChapterInput] = useState("");
  const [librarySubjectFilter, setLibrarySubjectFilter] = useState<"all" | Subject>("all");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [pendingOcr, setPendingOcr] = useState<PendingOcr | null>(null);
  const [ocrStart, setOcrStart] = useState(1);
  const [ocrEnd, setOcrEnd] = useState(20);
  const [selectedBanks, setSelectedBanks] = useState<string[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState<ExamSelectionMode>("combined");
  const [bankRules, setBankRules] = useState<Record<string, BankSelectionRule>>({});
  const [randomOrder, setRandomOrder] = useState(true);
  const [questionCount, setQuestionCount] = useState(10);
  const [exam, setExam] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<ExamAnswer>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showReset, setShowReset] = useState(false);
  const [bankToDelete, setBankToDelete] = useState<Bank | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"loading" | "saving" | "saved" | "error">("loading");
  const fileInput = useRef<HTMLInputElement>(null);
  const reprocessTarget = useRef<Bank | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadDeviceRecord<SavedLibrary>("library"),
      loadDeviceRecord<SavedSettings>("settings"),
      loadDeviceRecord<SavedProgress>("progress"),
    ])
      .then(([library, settings, progressState]) => {
        if (!active) return;
        const restoredBanks = library?.version === 1 ? sanitizeBanks(library.banks) : [];
        const questionMap = new Map(restoredBanks.flatMap((bank) => bank.questions).map((question) => [question.id, question]));
        const restoredExam = progressState?.version === 1
          ? progressState.examQuestionIds.map((id) => questionMap.get(id)).filter((question): question is Question => Boolean(question))
          : [];

        setBanks(restoredBanks);
        if (library?.version === 1 && SUBJECTS.includes(library.subject)) setSubject(library.subject);
        if (settings?.version === 1) {
          setSelectedBanks(settings.selectedBanks.filter((id) => restoredBanks.some((bank) => bank.id === id)));
          setSelectedChapters(settings.selectedChapters);
          setRandomOrder(settings.randomOrder);
          setQuestionCount(Math.max(10, settings.questionCount));
          setSelectionMode(settings.selectionMode === "individual" ? "individual" : "combined");
          setBankRules(Object.fromEntries(
            Object.entries(settings.bankRules ?? {})
              .filter(([bankId]) => restoredBanks.some((bank) => bank.id === bankId))
              .map(([bankId, rule]) => [bankId, {
                count: Math.max(1, Math.floor(rule.count || 10)),
                randomOrder: Boolean(rule.randomOrder),
              }]),
          ));
        }
        if (progressState?.version === 1 && restoredExam.length) {
          setExam(restoredExam);
          setAnswers(progressState.answers);
          setCurrentIndex(Math.min(progressState.currentIndex, restoredExam.length - 1));
          setScreen(progressState.screen === "exam" || progressState.screen === "result" ? progressState.screen : "library");
        }
        if (restoredBanks.length) setNotice(`${restoredBanks.length.toLocaleString("bn-BD")}টি সেভ করা প্রশ্নব্যাংক ফিরিয়ে আনা হয়েছে।`);
        setStorageReady(true);
        setStorageStatus("saved");
      })
      .catch(() => {
        if (!active) return;
        setStorageReady(true);
        setStorageStatus("error");
        setNotice("এই ব্রাউজারে সেভ করা ডেটা পড়া যায়নি। Private browsing বন্ধ করে আবার চেষ্টা করুন।");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    setStorageStatus("saving");
    const timer = window.setTimeout(() => {
      void saveDeviceRecord("library", { version: 1, banks: sanitizeBanks(banks), subject } satisfies SavedLibrary)
        .then(() => setStorageStatus("saved"))
        .catch(() => setStorageStatus("error"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [banks, storageReady, subject]);

  useEffect(() => {
    if (!storageReady) return;
    const timer = window.setTimeout(() => {
      void saveDeviceRecord("settings", {
        version: 1,
        selectedBanks,
        selectedChapters,
        randomOrder,
        questionCount,
        selectionMode,
        bankRules,
      } satisfies SavedSettings).catch(() => setStorageStatus("error"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [bankRules, questionCount, randomOrder, selectedBanks, selectedChapters, selectionMode, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    const timer = window.setTimeout(() => {
      void saveDeviceRecord("progress", {
        version: 1,
        screen,
        examQuestionIds: exam.map((question) => question.id),
        answers,
        currentIndex,
      } satisfies SavedProgress).catch(() => setStorageStatus("error"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [answers, currentIndex, exam, screen, storageReady]);

  const allQuestions = useMemo(() => banks.flatMap((bank) => bank.questions), [banks]);
  const visibleBanks = useMemo(
    () => banks.filter((bank) => librarySubjectFilter === "all" || bank.subject === librarySubjectFilter),
    [banks, librarySubjectFilter],
  );
  const chosenBankIds = selectedBanks.length ? selectedBanks : banks.map((bank) => bank.id);
  const setupQuestions = useMemo(
    () => allQuestions.filter((question) => chosenBankIds.includes(question.sourceId)),
    [allQuestions, chosenBankIds],
  );
  const chapters = useMemo(
    () => [...new Set(setupQuestions.map((question) => question.chapter))],
    [setupQuestions],
  );
  const eligibleQuestions = useMemo(
    () =>
      setupQuestions.filter(
        (question) => !selectedChapters.length || selectedChapters.includes(question.chapter),
      ),
    [setupQuestions, selectedChapters],
  );
  const eligibleQuestionCounts = useMemo(
    () => new Map(chosenBankIds.map((bankId) => [
      bankId,
      eligibleQuestions.filter((question) => question.sourceId === bankId).length,
    ])),
    [chosenBankIds, eligibleQuestions],
  );
  const bankRuleFor = (bankId: string): BankSelectionRule =>
    bankRules[bankId] ?? { count: 10, randomOrder };
  const individualQuestionCount = chosenBankIds.reduce((total, bankId) => {
    const available = eligibleQuestionCounts.get(bankId) ?? 0;
    return total + Math.min(Math.max(1, bankRuleFor(bankId).count), available);
  }, 0);
  const plannedQuestionCount = selectionMode === "individual"
    ? individualQuestionCount
    : Math.min(Math.max(10, questionCount), eligibleQuestions.length || 0);
  const canStartExam = eligibleQuestions.length >= 10 && plannedQuestionCount >= 10;

  const updateBankRule = (bankId: string, change: Partial<BankSelectionRule>) => {
    setBankRules((current) => ({
      ...current,
      [bankId]: {
        ...(current[bankId] ?? { count: 10, randomOrder }),
        ...change,
      },
    }));
  };

  const addBank = (name: string, chosenSubject: Subject, chapter: string | undefined, mode: ImportMode, questions: Question[], pages?: number) => {
    const existingBank = banks.find((bank) =>
      bank.name === name && bank.subject === chosenSubject && (bank.chapter ?? "") === (chapter ?? ""),
    );
    const bankId = existingBank?.id ?? questions[0]?.sourceId ?? uid("bank");
    const refreshedQuestions = questions.map((question) => ({ ...question, sourceId: bankId, sourceName: name }));
    const bank: Bank = { id: bankId, name, subject: chosenSubject, chapter, mode, pages, questions: refreshedQuestions };
    setBanks((current) => existingBank
      ? current.map((item) => item.id === existingBank.id ? bank : item)
      : [...current, bank]);
    setSelectedBanks((current) => current.includes(bankId) ? current : [...current, bankId]);
    if (existingBank) {
      setExam([]);
      setAnswers({});
      setCurrentIndex(0);
    }
    const detectedAnswers = refreshedQuestions.filter((question) => question.correct.length).length;
    setNotice(existingBank
      ? `${name} আবার প্রসেস করে আপডেট হয়েছে — ${detectedAnswers}টি উত্তর শনাক্ত।`
      : `${name} থেকে ${questions.length}টি প্রশ্ন যোগ হয়েছে।`);
  };

  const extractTextPdf = async (file: File, chosenSubject: Subject, chosenChapter?: string) => {
    setBusy(true);
    setProgress(2);
    setStatus(`${file.name} পড়া হচ্ছে…`);
    setNotice("");
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = `${PUBLIC_BASE_PATH}/pdf.worker.min.mjs`;
      const data = new Uint8Array(await file.arrayBuffer());
      const loadingTask = pdfjs.getDocument({ data });
      const pdfDocument = await loadingTask.promise;
      const sourceId = uid("bank");
      const rawPageLines: string[][] = [];
      const rawVisualPageLines: string[][] = [];
      const visualAnswerLines: string[] = [];
      let checkedCharacters = 0;

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageLines = pdfItemsToLines(content.items);
        const visualPageLines = pdfItemsToVisualLines(content.items);
        rawVisualPageLines.push(visualPageLines);
        visualAnswerLines.push(...visualPageLines);
        const text = pageLines.join("\n");
        rawPageLines.push(pageLines);
        if (pageNumber <= 3) checkedCharacters += text.replace(/\s/g, "").length;
        setProgress(Math.round((pageNumber / pdfDocument.numPages) * 92));
        setStatus(`পৃষ্ঠা ${pageNumber}/${pdfDocument.numPages} পড়া হয়েছে`);

        if (pageNumber === Math.min(3, pdfDocument.numPages) && checkedCharacters < 120) {
          const pageCount = pdfDocument.numPages;
          await loadingTask.destroy();
          setPendingOcr({ file, subject: chosenSubject, chapter: chosenChapter, pages: pageCount });
          setOcrStart(1);
          setOcrEnd(Math.min(20, pageCount));
          setStatus("");
          setProgress(0);
          setNotice("এই PDF-টি স্ক্যান করা। OCR-এর জন্য পেজ রেঞ্জ বেছে নিন।");
          return;
        }
      }

      const pageTexts = prepareExtractedPageTexts(rawPageLines);
      const visualPageTexts = prepareExtractedPageTexts(rawVisualPageLines);
      const linePages = pageTexts.flatMap((text, pageIndex) => text.split("\n").map(() => pageIndex + 1));
      const visualLinePages = visualPageTexts.flatMap((text, pageIndex) => text.split("\n").map(() => pageIndex + 1));

      const primaryQuestions = parseQuestionText(
        pageTexts.join("\n"),
        { id: sourceId, name: file.name, subject: chosenSubject, chapter: chosenChapter },
        linePages,
        visualAnswerLines,
      );
      const visualQuestions = parseQuestionText(
        visualPageTexts.join("\n"),
        { id: sourceId, name: file.name, subject: chosenSubject, chapter: chosenChapter },
        visualLinePages,
        visualAnswerLines,
      );
      const questions = chooseBetterQuestionSet(primaryQuestions, visualQuestions);
      await loadingTask.destroy();
      if (!questions.length) throw new Error("প্রশ্নের কাঠামো শনাক্ত করা যায়নি। ম্যানুয়াল টেক্সট অপশনটি চেষ্টা করুন।");
      addBank(file.name, chosenSubject, chosenChapter, "text", questions, pageTexts.length);
      setProgress(100);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF পড়া যায়নি।");
    } finally {
      setBusy(false);
      window.setTimeout(() => setProgress(0), 500);
      setStatus("");
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleFiles = async (files: FileList | File[], target?: Bank) => {
    const pdfs = Array.from(files).filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) {
      setNotice("শুধু PDF ফাইল বেছে নিন।");
      return;
    }
    for (const file of pdfs) {
      if (file.size > 120 * 1024 * 1024) {
        setNotice(`${file.name} 120 MB-এর বেশি—ছোট ভাগে ভাগ করে দিন।`);
        continue;
      }
      const chosenSubject = target?.subject ?? subject;
      const chosenChapter = target?.chapter ?? (chapterInput.trim() || inferChapterLabel(file.name) || undefined);
      await extractTextPdf(file, chosenSubject, chosenChapter);
    }
  };

  const openFilePicker = (target?: Bank) => {
    if (busy || !fileInput.current) return;
    reprocessTarget.current = target ?? null;
    fileInput.current.value = "";
    fileInput.current.click();
  };

  const handleFileSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    const target = reprocessTarget.current;
    reprocessTarget.current = null;
    event.currentTarget.value = "";
    if (!files.length) return;
    if (target) {
      setSubject(target.subject);
      setChapterInput(target.chapter ?? "");
    }
    void handleFiles(files, target ?? undefined);
  };

  const runOcr = async () => {
    if (!pendingOcr) return;
    const start = Math.max(1, Math.min(ocrStart, pendingOcr.pages));
    const end = Math.max(start, Math.min(ocrEnd, pendingOcr.pages, start + 39));
    setBusy(true);
    setProgress(1);
    setNotice("");
    try {
      const pdfjs = await import("pdfjs-dist");
      const { createWorker } = await import("tesseract.js");
      pdfjs.GlobalWorkerOptions.workerSrc = `${PUBLIC_BASE_PATH}/pdf.worker.min.mjs`;
      const data = new Uint8Array(await pendingOcr.file.arrayBuffer());
      const loadingTask = pdfjs.getDocument({ data });
      const pdfDocument = await loadingTask.promise;
      let activeOcrPage = start;
      const worker = await createWorker("eng", 1, {
        cacheMethod: "none",
        logger: (message) => {
          if (message.status === "recognizing text") {
            const pageProgress = Math.round((Number(message.progress) || 0) * 100);
            setStatus(`OCR চলছে — পৃষ্ঠা ${activeOcrPage}/${end}, ${pageProgress}%`);
          }
        },
      });
      const texts: string[] = [];
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        activeOcrPage = pageNumber;
        setStatus(`OCR চলছে — পৃষ্ঠা ${pageNumber}/${end}`);
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.7 });
        const canvas = window.document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("OCR canvas তৈরি করা যায়নি।");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        const result = await worker.recognize(canvas);
        texts.push(result.data.text);
        canvas.width = 1;
        canvas.height = 1;
        setProgress(Math.round(((pageNumber - start + 1) / (end - start + 1)) * 96));
      }
      await worker.terminate();
      await loadingTask.destroy();
      const sourceId = uid("bank");
      const chapterSuffix = start === end ? `পৃষ্ঠা ${start}` : `পৃষ্ঠা ${start}-${end}`;
      const cleanedTexts = removeRepeatedPageFurniture(texts.map((text) => text.replace(/\r/g, "").split("\n")))
        .map((lines) => lines.join("\n"));
      const linePages = cleanedTexts.flatMap((text, pageIndex) => text.split("\n").map(() => start + pageIndex));
      const questions = parseQuestionText(
        cleanedTexts.join("\n"),
        { id: sourceId, name: `${pendingOcr.file.name} (${chapterSuffix})`, subject: pendingOcr.subject, chapter: pendingOcr.chapter },
        linePages,
      );
      if (!questions.length) throw new Error("এই পেজগুলোতে MCQ শনাক্ত করা যায়নি। অন্য পেজ রেঞ্জ চেষ্টা করুন।");
      addBank(`${pendingOcr.file.name} (${chapterSuffix})`, pendingOcr.subject, pendingOcr.chapter, "ocr", questions, end - start + 1);
      setPendingOcr(null);
      setProgress(100);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "OCR সম্পন্ন হয়নি।");
    } finally {
      setBusy(false);
      setStatus("");
      window.setTimeout(() => setProgress(0), 500);
    }
  };

  const addManual = () => {
    const sourceId = uid("bank");
    const name = `নিজের প্রশ্ন — ${new Date().toLocaleDateString("bn-BD")}`;
    const chosenChapter = chapterInput.trim() || undefined;
    const questions = parseQuestionText(manualText, { id: sourceId, name, subject, chapter: chosenChapter });
    if (!questions.length) {
      setNotice("কমপক্ষে একটি প্রশ্ন, দুইটি অপশন এবং প্রশ্ন নম্বর দিন। নিচের নমুনা ফরম্যাটটি অনুসরণ করুন।");
      return;
    }
    addBank(name, subject, chosenChapter, "manual", questions);
    setManualText("");
    setManualOpen(false);
  };

  const startExam = () => {
    if (!canStartExam) {
      setNotice(
        selectionMode === "individual" && eligibleQuestions.length >= 10
          ? `PDF অনুযায়ী মোট ${plannedQuestionCount}টি প্রশ্ন নির্বাচন করা হয়েছে। পরীক্ষা শুরু করতে কমপক্ষে ১০টি নির্বাচন করুন।`
          : `নির্বাচিত অংশে ${eligibleQuestions.length}টি প্রশ্ন আছে। পরীক্ষা শুরু করতে কমপক্ষে ১০টি প্রয়োজন।`,
      );
      return;
    }
    setExam(selectExamQuestions({
      questions: eligibleQuestions,
      sourceIds: chosenBankIds,
      mode: selectionMode,
      totalCount: Math.min(Math.max(10, questionCount), eligibleQuestions.length),
      randomOrder,
      sourceRules: bankRules,
    }));
    setAnswers({});
    setCurrentIndex(0);
    setScreen("exam");
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectOption = (question: Question, optionIndex: number) => {
    const multi = question.correct.length > 1;
    setAnswers((current) => {
      const selected = current[question.id] ?? [];
      const next = multi
        ? selected.includes(optionIndex)
          ? selected.filter((value) => value !== optionIndex)
          : [...selected, optionIndex]
        : [optionIndex];
      return { ...current, [question.id]: next };
    });
  };

  const finishExam = () => {
    setScreen("result");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const removeBank = () => {
    if (!bankToDelete) return;
    const removedBank = bankToDelete;
    setBanks((items) => items.filter((item) => item.id !== removedBank.id));
    setSelectedBanks((items) => items.filter((id) => id !== removedBank.id));
    setBankRules((current) => {
      const next = { ...current };
      delete next[removedBank.id];
      return next;
    });
    setBankToDelete(null);
    setNotice(`${removedBank.name} প্রশ্নব্যাংক থেকে মুছে ফেলা হয়েছে।`);
  };

  const resetEverything = async () => {
    setStorageReady(false);
    try {
      await clearDeviceStorage();
    } catch {
      setStorageStatus("error");
    }
    setBanks([]);
    setSelectedBanks([]);
    setSelectedChapters([]);
    setSelectionMode("combined");
    setBankRules({});
    setRandomOrder(true);
    setQuestionCount(10);
    setExam([]);
    setAnswers({});
    setPendingOcr(null);
    setManualText("");
    setNotice("এই ডিভাইসে সেভ করা সব প্রশ্ন, সেটিংস ও ফলাফল মুছে গেছে।");
    setScreen("library");
    setShowReset(false);
    setStorageReady(true);
    setStorageStatus("saved");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const result = useMemo(() => {
    let correct = 0;
    let wrong = 0;
    let unscored = 0;
    let unanswered = 0;
    for (const question of exam) {
      const selected = answers[question.id] ?? [];
      if (!selected.length) unanswered += 1;
      if (!question.correct.length) {
        unscored += 1;
        continue;
      }
      const same =
        [...selected].sort().join(",") === [...question.correct].sort().join(",");
      if (same) correct += 1;
      else wrong += 1;
    }
    return { correct, wrong, unscored, unanswered, scorable: exam.length - unscored };
  }, [answers, exam]);

  const renderHeader = () => (
    <header className="site-header">
      <button className="brand" onClick={() => setScreen("library")} aria-label="হোমে যান">
        <span className="brand-mark">M</span>
        <span>
          <strong>Mockly</strong>
          <small>আপনার প্রশ্ন, আপনার পরীক্ষা</small>
        </span>
      </button>
      <div className="header-actions">
        <span className={`privacy-pill ${storageStatus === "error" ? "storage-error" : ""}`}>
          <span className="privacy-dot" />
          {storageStatus === "loading" ? "সেভড ডেটা খোঁজা হচ্ছে" : storageStatus === "saving" ? "ডিভাইসে সেভ হচ্ছে" : storageStatus === "error" ? "সেভ করা যায়নি" : "এই ডিভাইসে সেভড"}
        </span>
        <button className="text-button danger-text" onClick={() => setShowReset(true)}>সব মুছুন</button>
      </div>
    </header>
  );

  return (
    <main>
      {renderHeader()}

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="বার্তা বন্ধ করুন">×</button>
        </div>
      )}

      {screen === "library" && (
        <div className="page-shell library-page">
          <section className="hero">
            <div>
              <span className="eyebrow">ব্যক্তিগত মক টেস্ট</span>
              <h1>PDF দিন। প্রশ্ন বাছুন।<br />পরীক্ষা শুরু করুন।</h1>
              <p>সাতটি বিষয়ের প্রশ্নব্যাংক থেকে সিরিয়াল বা র‍্যান্ডম মক টেস্ট—কোনো অ্যাকাউন্ট ছাড়াই, আপনার ডিভাইসে স্বয়ংক্রিয়ভাবে সেভড।</p>
            </div>
            <div className="hero-stat" aria-label="বর্তমান প্রশ্ন সংখ্যা">
              <strong>{allQuestions.length.toLocaleString("bn-BD")}</strong>
              <span>প্রশ্ন প্রস্তুত</span>
              <small>{banks.length ? `${banks.length.toLocaleString("bn-BD")}টি প্রশ্নব্যাংক` : "PDF যোগ করলে এখানে দেখা যাবে"}</small>
            </div>
          </section>

          <section className="workspace-grid">
            <div className="card import-card">
              <div className="section-heading">
                <div>
                  <span className="step-number">০১</span>
                  <h2>প্রশ্ন যোগ করুন</h2>
                </div>
                <span className="muted">PDF বা টেক্সট</span>
              </div>

              <div className="import-fields">
                <div className="field-label">
                  <span id="subject-label">বিষয়</span>
                  <ThemedSelect
                    id="subject"
                    ariaLabelledBy="subject-label"
                    value={subject}
                    options={SUBJECTS.map((item) => ({ value: item, label: item }))}
                    onChange={(nextSubject) => setSubject(nextSubject as Subject)}
                    disabled={busy}
                  />
                </div>
                <label className="field-label" htmlFor="chapter-input">চ্যাপ্টার <small>ঐচ্ছিক</small>
                  <input id="chapter-input" className="text-input" value={chapterInput} onChange={(event) => setChapterInput(event.target.value)} placeholder="যেমন: Chapter 4" disabled={busy} />
                </label>
              </div>
              <small className="chapter-hint">খালি রাখলে “4th chapter”–এর মতো ফাইলের নাম থেকে নিজে শনাক্ত হবে।</small>

              <div
                className={`drop-zone ${dragging ? "dragging" : ""} ${busy ? "busy" : ""}`}
                onDragOver={(event: DragEvent) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event: DragEvent) => { event.preventDefault(); setDragging(false); reprocessTarget.current = null; void handleFiles(event.dataTransfer.files); }}
                onClick={() => openFilePicker()}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openFilePicker(); }}
              >
                <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={handleFileSelection} />
                <span className="upload-icon">↑</span>
                <strong>{busy ? status || "প্রসেস হচ্ছে…" : "PDF এখানে ছাড়ুন"}</strong>
                <span>{busy ? `${progress}% সম্পন্ন` : "অথবা ফাইল বেছে নিন · সর্বোচ্চ 120 MB"}</span>
                {busy && <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>}
              </div>

              <div className="divider"><span>অথবা</span></div>
              <button className="secondary-button full" onClick={() => setManualOpen((value) => !value)} disabled={busy}>
                <span>＋</span> টেক্সট থেকে প্রশ্ন যোগ করুন
              </button>

              {manualOpen && (
                <div className="manual-panel">
                  <textarea
                    value={manualText}
                    onChange={(event) => setManualText(event.target.value)}
                    placeholder={"1. Which statement is correct?\nA. First option\nB. Second option\nC. Third option\nD. Fourth option\nAnswer: B\nExplanation: Optional note"}
                    rows={10}
                  />
                  <div className="manual-actions">
                    <small>প্রতিটি প্রশ্নে নম্বর ও অন্তত ২টি অপশন দিন</small>
                    <button className="primary-button" onClick={addManual}>যোগ করুন</button>
                  </div>
                </div>
              )}

              <div className="privacy-note">
                <span>⌁</span>
                <p><strong>প্রশ্ন ও অগ্রগতি এই ডিভাইসে সেভ হয়</strong><br />মূল PDF সার্ভারে আপলোড হয় না। Parsed প্রশ্ন, সেটিংস ও পরীক্ষার অগ্রগতি শুধু এই ব্রাউজারের IndexedDB-তে থাকে।</p>
              </div>
            </div>

            <div className="card library-card">
              <div className="section-heading">
                <div>
                  <span className="step-number">০২</span>
                  <h2>আপনার প্রশ্নব্যাংক</h2>
                </div>
                <span className="count-badge">{banks.length.toLocaleString("bn-BD")}</span>
              </div>

              {banks.length > 0 && (
                <div className="library-toolbar">
                  <span id="library-subject-filter-label">বিষয় অনুযায়ী দেখুন</span>
                  <ThemedSelect
                    id="library-subject-filter"
                    ariaLabelledBy="library-subject-filter-label"
                    value={librarySubjectFilter}
                    compact
                    options={[
                      { value: "all", label: `সব বিষয় (${banks.length.toLocaleString("bn-BD")})` },
                      ...SUBJECTS.flatMap((item) => {
                        const count = banks.filter((bank) => bank.subject === item).length;
                        return count ? [{ value: item, label: `${item} (${count.toLocaleString("bn-BD")})` }] : [];
                      }),
                    ]}
                    onChange={(nextFilter) => setLibrarySubjectFilter(nextFilter as "all" | Subject)}
                  />
                </div>
              )}

              {!banks.length ? (
                <div className="empty-state">
                  <span className="empty-lines"><i /><i /><i /></span>
                  <h3>এখনও কোনো প্রশ্ন নেই</h3>
                  <p>বাম পাশ থেকে PDF বা টেক্সট যোগ করলে বিষয় ও চ্যাপ্টার অনুযায়ী প্রশ্ন এখানে সাজানো হবে।</p>
                </div>
              ) : (
                <div className="bank-list">
                  {visibleBanks.map((bank) => {
                    const bankChapters = [...new Set(bank.questions.map((question) => question.chapter))];
                    const answered = bank.questions.filter((question) => question.correct.length).length;
                    return (
                      <article className="bank-item" key={bank.id}>
                        <div className="file-icon">PDF</div>
                        <div className="bank-copy">
                          <strong title={bank.name}>{bank.name}</strong>
                          <span className="bank-tags"><b>{bank.subject}</b>{bank.chapter && <b>{bank.chapter}</b>}</span>
                          <span>{bank.questions.length.toLocaleString("bn-BD")} প্রশ্ন · {bank.chapter ? "১টি চ্যাপ্টার" : `${bankChapters.length.toLocaleString("bn-BD")}টি অংশ`}</span>
                          <small>{bank.mode === "ocr" ? "OCR" : bank.mode === "manual" ? "টেক্সট" : "PDF টেক্সট"} · {answered.toLocaleString("bn-BD")}টির উত্তর শনাক্ত</small>
                        </div>
                        <div className="bank-actions">
                          {bank.mode !== "manual" && <button className="bank-refresh-button" type="button" disabled={busy} onClick={() => openFilePicker(bank)}><i aria-hidden="true">↻</i><span>আবার পড়ুন</span></button>}
                          <button className="icon-button" aria-label={`${bank.name} মুছুন`} onClick={() => setBankToDelete(bank)}>×</button>
                        </div>
                      </article>
                    );
                  })}
                  {!visibleBanks.length && <div className="filtered-empty">এই বিষয়ের কোনো প্রশ্নব্যাংক নেই।</div>}
                </div>
              )}

              <button className="primary-button start-button" disabled={allQuestions.length < 10 || busy} onClick={() => {
                setQuestionCount(Math.min(Math.max(10, allQuestions.length), 50));
                setScreen("setup");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}>
                পরীক্ষা সাজান <span>→</span>
              </button>
              {allQuestions.length > 0 && allQuestions.length < 10 && <small className="minimum-note">আরও {10 - allQuestions.length}টি প্রশ্ন যোগ করলে পরীক্ষা শুরু হবে।</small>}
            </div>
          </section>

          <section className="subject-strip" aria-label="সমর্থিত বিষয়">
            <span>৭টি বিষয়</span>
            <div>{SUBJECTS.map((item) => <span key={item}>{item}</span>)}</div>
          </section>
        </div>
      )}

      {screen === "setup" && (
        <div className="page-shell narrow-shell">
          <button className="back-button" onClick={() => setScreen("library")}>← প্রশ্নব্যাংকে ফিরুন</button>
          <section className="setup-intro">
            <span className="eyebrow">পরীক্ষার সেটআপ</span>
            <h1>কেমন পরীক্ষা দিতে চান?</h1>
            <p>উৎস, চ্যাপ্টার, প্রশ্নসংখ্যা ও প্রশ্নের ক্রম ঠিক করুন।</p>
          </section>

          <div className="setup-grid">
            <section className="card setup-card">
              <div className="setup-section">
                <h2><span>১</span> প্রশ্নের উৎস</h2>
                <div className="choice-list">
                  {banks.map((bank) => {
                    const selected = chosenBankIds.includes(bank.id);
                    const rule = bankRuleFor(bank.id);
                    const available = eligibleQuestionCounts.get(bank.id) ?? 0;
                    const displayedCount = available ? Math.min(Math.max(1, rule.count), available) : 0;
                    return (
                      <div className={selectionMode === "individual" && selected ? "source-choice with-rule" : "source-choice"} key={bank.id}>
                        <label className="check-row">
                          <input type="checkbox" checked={selected} onChange={() => {
                            setSelectedBanks((current) => {
                              const normalized = current.length ? current : banks.map((item) => item.id);
                              return normalized.includes(bank.id) ? normalized.filter((id) => id !== bank.id) : [...normalized, bank.id];
                            });
                            setSelectedChapters([]);
                          }} />
                          <span><strong>{bank.name}</strong><small>{bank.subject}{bank.chapter ? ` · ${bank.chapter}` : ""} · {bank.questions.length.toLocaleString("bn-BD")} প্রশ্ন</small></span>
                        </label>
                        {selectionMode === "individual" && selected && (
                          <div className="bank-rule">
                            <div>
                              <span className="rule-label">ক্রম</span>
                              <div className="segmented compact">
                                <button className={!rule.randomOrder ? "active" : ""} onClick={() => updateBankRule(bank.id, { randomOrder: false })}>সিরিয়াল</button>
                                <button className={rule.randomOrder ? "active" : ""} onClick={() => updateBankRule(bank.id, { randomOrder: true })}>র‍্যান্ডম</button>
                              </div>
                            </div>
                            <div>
                              <span className="rule-label">এই PDF থেকে</span>
                              <div className="number-control compact">
                                <button disabled={!available} onClick={() => updateBankRule(bank.id, { count: Math.max(1, displayedCount - 5) })}>−</button>
                                <input
                                  aria-label={`${bank.name} থেকে প্রশ্নসংখ্যা`}
                                  type="number"
                                  min={1}
                                  max={available}
                                  disabled={!available}
                                  value={displayedCount}
                                  onChange={(event) => updateBankRule(bank.id, {
                                    count: Math.min(available, Math.max(1, Number(event.target.value) || 1)),
                                  })}
                                />
                                <button disabled={!available} onClick={() => updateBankRule(bank.id, { count: Math.min(available, displayedCount + 5) })}>＋</button>
                              </div>
                              <small className="rule-available">{available.toLocaleString("bn-BD")}টি পাওয়া যাচ্ছে</small>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="selection-mode">
                  <span className="rule-label">প্রশ্ন নেওয়ার নিয়ম</span>
                  <div className="segmented">
                    <button className={selectionMode === "combined" ? "active" : ""} onClick={() => setSelectionMode("combined")}>সব PDF মিলিয়ে</button>
                    <button className={selectionMode === "individual" ? "active" : ""} onClick={() => setSelectionMode("individual")}>PDF অনুযায়ী আলাদা</button>
                  </div>
                  <small className="helper">
                    {selectionMode === "combined"
                      ? "Serial বা Random—দুই ক্ষেত্রেই নির্বাচিত সব PDF থেকে ভারসাম্য রেখে মোট প্রশ্ন নেওয়া হবে।"
                      : "প্রতিটি নির্বাচিত PDF-এর নিচে আলাদা প্রশ্নসংখ্যা ও ক্রম ঠিক করুন।"}
                  </small>
                </div>
              </div>

              <div className="setup-section">
                <div className="title-row"><h2><span>২</span> চ্যাপ্টার</h2><button className="text-button" onClick={() => setSelectedChapters([])}>পুরো বই</button></div>
                <div className="chip-list">
                  {chapters.map((chapter) => (
                    <button key={chapter} className={selectedChapters.includes(chapter) ? "chip active" : "chip"} onClick={() => setSelectedChapters((current) => current.includes(chapter) ? current.filter((item) => item !== chapter) : [...current, chapter])}>{chapter}</button>
                  ))}
                </div>
                <small className="helper">কিছু নির্বাচন না করলে নির্বাচিত সব প্রশ্নব্যাংক ধরা হবে।</small>
              </div>

              {selectionMode === "combined" && (
                <div className="setup-section split-fields">
                  <div>
                    <h2><span>৩</span> প্রশ্নের ক্রম</h2>
                    <div className="segmented">
                      <button className={!randomOrder ? "active" : ""} onClick={() => setRandomOrder(false)}>সিরিয়াল</button>
                      <button className={randomOrder ? "active" : ""} onClick={() => setRandomOrder(true)}>র‍্যান্ডম</button>
                    </div>
                  </div>
                  <div>
                    <h2><span>৪</span> প্রশ্নসংখ্যা</h2>
                    <div className="number-control">
                      <button onClick={() => setQuestionCount((value) => Math.max(10, value - 5))}>−</button>
                      <input type="number" min={10} max={eligibleQuestions.length} value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value) || 10)} />
                      <button onClick={() => setQuestionCount((value) => Math.min(eligibleQuestions.length, value + 5))}>＋</button>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <aside className="card summary-card">
              <span className="eyebrow">সারাংশ</span>
              <div className="summary-number">{plannedQuestionCount.toLocaleString("bn-BD")}</div>
              <p>টি প্রশ্নের পরীক্ষা</p>
              <dl>
                <div><dt>মোট প্রশ্ন</dt><dd>{eligibleQuestions.length.toLocaleString("bn-BD")}</dd></div>
                <div><dt>প্রশ্নব্যাংক</dt><dd>{chosenBankIds.length.toLocaleString("bn-BD")}</dd></div>
                <div><dt>চ্যাপ্টার</dt><dd>{selectedChapters.length ? selectedChapters.length.toLocaleString("bn-BD") : "সব"}</dd></div>
                <div><dt>নিয়ম</dt><dd>{selectionMode === "individual" ? "PDF অনুযায়ী" : "সব মিলিয়ে"}</dd></div>
                <div><dt>ক্রম</dt><dd>{selectionMode === "individual" ? "আলাদা সেটিং" : randomOrder ? "র‍্যান্ডম" : "সিরিয়াল"}</dd></div>
              </dl>
              <button className="primary-button full" onClick={startExam} disabled={!canStartExam}>পরীক্ষা শুরু করুন <span>→</span></button>
              <small>{selectionMode === "individual" ? "সব PDF-এর নির্বাচিত প্রশ্ন মিলিয়ে কমপক্ষে ১০টি প্রয়োজন" : "কমপক্ষে ১০টি প্রশ্ন প্রয়োজন"}</small>
            </aside>
          </div>
        </div>
      )}

      {screen === "exam" && exam[currentIndex] && (
        <div className="exam-layout">
          <section className="exam-main">
            <div className="exam-topline">
              <div><span>প্রশ্ন {currentIndex + 1}/{exam.length}</span><strong>{exam[currentIndex].subject}</strong></div>
              <button className="secondary-button" onClick={finishExam}>পরীক্ষা জমা দিন</button>
            </div>
            <div className="exam-progress"><div style={{ width: `${((currentIndex + 1) / exam.length) * 100}%` }} /></div>
            <article className="question-card">
              <div className="question-meta"><span>{exam[currentIndex].chapter}</span><span>{exam[currentIndex].sourceName}</span></div>
              <h1>{exam[currentIndex].prompt}</h1>
              <p className="selection-hint">{exam[currentIndex].correct.length > 1 ? "একাধিক উত্তর নির্বাচন করুন" : "সঠিক উত্তরটি নির্বাচন করুন"}</p>
              <div className="options-list">
                {exam[currentIndex].options.map((option, optionIndex) => {
                  const selected = (answers[exam[currentIndex].id] ?? []).includes(optionIndex);
                  return (
                    <button key={`${optionIndex}-${option}`} className={selected ? "option selected" : "option"} onClick={() => selectOption(exam[currentIndex], optionIndex)}>
                      <span>{LETTERS[optionIndex]}</span><strong>{option}</strong><i>{selected ? "✓" : ""}</i>
                    </button>
                  );
                })}
              </div>
            </article>
            <div className="exam-navigation">
              <button className="secondary-button" disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => value - 1)}>← আগের প্রশ্ন</button>
              {currentIndex === exam.length - 1 ? (
                <button className="primary-button" onClick={finishExam}>ফলাফল দেখুন</button>
              ) : (
                <button className="primary-button" onClick={() => setCurrentIndex((value) => value + 1)}>পরের প্রশ্ন →</button>
              )}
            </div>
          </section>
          <aside className="question-palette">
            <div className="palette-heading"><strong>প্রশ্ন তালিকা</strong><span>{Object.values(answers).filter((value) => value.length).length}/{exam.length} উত্তর</span></div>
            <div className="palette-grid">
              {exam.map((question, index) => (
                <button key={question.id} className={`${index === currentIndex ? "current" : ""} ${(answers[question.id] ?? []).length ? "answered" : ""}`} onClick={() => setCurrentIndex(index)}>{index + 1}</button>
              ))}
            </div>
            <div className="palette-key"><span><i className="answered" /> উত্তর দেওয়া</span><span><i className="current" /> বর্তমান</span></div>
          </aside>
        </div>
      )}

      {screen === "result" && (
        <div className="page-shell narrow-shell result-page">
          <section className="result-hero">
            <span className="eyebrow">পরীক্ষা সম্পন্ন</span>
            <h1>আপনার ফলাফল</h1>
            <div className="score-ring">
              <strong>{result.scorable ? Math.round((result.correct / result.scorable) * 100) : 0}%</strong>
              <span>{result.correct.toLocaleString("bn-BD")}/{result.scorable.toLocaleString("bn-BD")} সঠিক</span>
            </div>
            <div className="result-stats">
              <div><strong>{result.correct.toLocaleString("bn-BD")}</strong><span>সঠিক</span></div>
              <div><strong>{result.wrong.toLocaleString("bn-BD")}</strong><span>ভুল</span></div>
              <div><strong>{result.unanswered.toLocaleString("bn-BD")}</strong><span>উত্তরহীন</span></div>
              <div><strong>{result.unscored.toLocaleString("bn-BD")}</strong><span>উত্তর-কী নেই</span></div>
            </div>
            <div className="result-actions">
              <button className="secondary-button" onClick={() => setScreen("setup")}>নতুন সেটআপ</button>
              <button className="primary-button" onClick={() => { setScreen("library"); setExam([]); setAnswers({}); }}>প্রশ্নব্যাংকে ফিরুন</button>
            </div>
          </section>

          <section className="review-section">
            <div className="section-heading"><div><span className="step-number">রিভিউ</span><h2>সব প্রশ্ন ও উত্তর</h2></div></div>
            <div className="review-list">
              {exam.map((question, index) => {
                const selected = answers[question.id] ?? [];
                const isCorrect = question.correct.length && [...selected].sort().join(",") === [...question.correct].sort().join(",");
                return (
                  <article className="review-item" key={question.id}>
                    <div className={`review-number ${!question.correct.length ? "neutral" : isCorrect ? "good" : "bad"}`}>{index + 1}</div>
                    <div>
                      <h3>{question.prompt}</h3>
                      <p>আপনার উত্তর: <strong>{selected.length ? selected.map((value) => `${LETTERS[value]}. ${question.options[value]}`).join("; ") : "দেওয়া হয়নি"}</strong></p>
                      {question.correct.length ? <p className="correct-answer">সঠিক উত্তর: {question.correct.map((value) => `${LETTERS[value]}. ${question.options[value]}`).join("; ")}</p> : <p className="unknown-answer">PDF-এ উত্তর-কী শনাক্ত হয়নি</p>}
                      {question.explanation && <p className="explanation">{question.explanation}</p>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {pendingOcr && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ocr-title">
          <div className="modal-card">
            <button className="modal-close" onClick={() => setPendingOcr(null)} disabled={busy}>×</button>
            <span className="modal-icon">◎</span>
            <span className="eyebrow">স্ক্যান করা PDF</span>
            <h2 id="ocr-title">কোন পেজগুলো OCR করবেন?</h2>
            <p><strong>{pendingOcr.file.name}</strong>–এ {pendingOcr.pages.toLocaleString("bn-BD")} পৃষ্ঠা আছে। সময় ও মেমরি কম রাখতে একবারে সর্বোচ্চ ৪০ পৃষ্ঠা নিন। পরে অন্য রেঞ্জ আবার যোগ করতে পারবেন।</p>
            <div className="range-fields">
              <label>শুরু<input type="number" min={1} max={pendingOcr.pages} value={ocrStart} onChange={(event) => setOcrStart(Number(event.target.value))} disabled={busy} /></label>
              <span>→</span>
              <label>শেষ<input type="number" min={1} max={pendingOcr.pages} value={ocrEnd} onChange={(event) => setOcrEnd(Number(event.target.value))} disabled={busy} /></label>
            </div>
            {busy && <><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><small className="modal-status">{status}</small></>}
            <button className="primary-button full" onClick={runOcr} disabled={busy}>{busy ? "OCR চলছে…" : "OCR শুরু করুন"}</button>
            <small>OCR ইংরেজি প্রশ্নের জন্য অপ্টিমাইজড। ভাষা-ডেটা ব্রাউজারে সেভ হবে না।</small>
          </div>
        </div>
      )}

      {showReset && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-title">
          <div className="modal-card reset-card">
            <span className="modal-icon danger">!</span>
            <h2 id="reset-title">সবকিছু মুছে ফেলবেন?</h2>
            <p>এই ডিভাইসে সেভ করা সব প্রশ্নব্যাংক, সেটিংস, উত্তর ও ফলাফল মুছে যাবে। এটি ফেরানো যাবে না।</p>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setShowReset(false)}>না, থাক</button><button className="danger-button" onClick={() => void resetEverything()}>হ্যাঁ, সব মুছুন</button></div>
          </div>
        </div>
      )}

      {bankToDelete && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-bank-title">
          <div className="modal-card reset-card">
            <button className="modal-close" type="button" onClick={() => setBankToDelete(null)} aria-label="বন্ধ করুন">×</button>
            <span className="modal-icon danger">!</span>
            <span className="eyebrow">প্রশ্নব্যাংক মুছুন</span>
            <h2 id="delete-bank-title">এই PDF-এর প্রশ্নগুলো মুছবেন?</h2>
            <p><strong className="delete-bank-name">{bankToDelete.name}</strong> থেকে যোগ হওয়া {bankToDelete.questions.length.toLocaleString("bn-BD")}টি প্রশ্ন এই ডিভাইস থেকে মুছে যাবে। পরে ফেরত পেতে PDF-টি আবার যোগ করতে হবে।</p>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setBankToDelete(null)}>না, রেখে দিন</button>
              <button className="danger-button" type="button" onClick={removeBank}>হ্যাঁ, মুছুন</button>
            </div>
          </div>
        </div>
      )}

      <footer><span>Mockly</span><p>Developed with <b aria-label="love">❤️</b> Jesmin Juthi</p><small>কোনো অ্যাকাউন্ট নেই · এই ডিভাইসে স্বয়ংক্রিয় সেভ</small></footer>
    </main>
  );
}
