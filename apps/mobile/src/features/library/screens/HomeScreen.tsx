import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable as NativePressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  View as NativeView,
  type PressableProps,
  type TextInputProps,
  type TextProps,
  type ViewProps,
  type ScrollViewInstance,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioStatus,
} from "expo-audio";
import * as Linking from "expo-linking";
import type { PickedBook, PlaybackCue } from "../types";
import {
  analyzeStory,
  generateNarrationScript,
  getApiBaseUrl,
  getApiHealth,
  generateAudio,
  importStoryDocument,
  type NarrationStyle,
  saveAnalysisFeedback,
  setApiBaseUrl,
  suggestChapterPlan,
  voiceProfileOptions,
  type GeneratedAudio,
  type NarrationScript,
  type StoryAnalysis,
} from "../../../services/api/client";

const playbackSpeeds = [0.75, 1, 1.25, 1.5, 2];
const LIBRARY_STORAGE_KEY = "storybook-audio-library";
const DISPLAY_MODE_STORAGE_KEY = "storybook-audio-display-mode";
const MAX_LIBRARY_ITEMS = 6;
const displayModes = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "eye-comfort", label: "Eye comfort" },
] as const;
type DisplayMode = (typeof displayModes)[number]["id"];

function isDisplayMode(value: string | null): value is DisplayMode {
  return displayModes.some((option) => option.id === value);
}

const DisplayModeContext = createContext<DisplayMode>("light");

function getDisplayPalette(mode: DisplayMode) {
  if (mode === "dark") {
    return {
      background: "#151311",
      surface: "#211e1b",
      raisedSurface: "#2b2521",
      darkSurface: "#211e1b",
      darkAccent: "#634658",
      text: "#f1e9e2",
      mutedText: "#c8bbb2",
      accentText: "#edbad2",
      border: "#4b423b",
    };
  }
  if (mode === "eye-comfort") {
    return {
      background: "#f0e5d1",
      surface: "#f7efdf",
      raisedSurface: "#e9dcc3",
      darkSurface: "#554735",
      darkAccent: "#806541",
      text: "#4a3b2a",
      mutedText: "#725c42",
      accentText: "#8a693b",
      border: "#d3c19f",
    };
  }
  return {
    background: "#fff9f7",
    surface: "#fffafd",
    raisedSurface: "#f5edf3",
    darkSurface: "#352a42",
    darkAccent: "#9b5b80",
    text: "#44334c",
    mutedText: "#67566a",
    accentText: "#9b5b80",
    border: "#edd8e5",
  };
}

function getColorMetrics(color: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    return null;
  }

  const value = match[1];
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  return {
    luminance: (red * 0.299 + green * 0.587 + blue * 0.114) / 255,
    saturation: maximum === 0 ? 0 : (maximum - minimum) / maximum,
  };
}

function themedTextColor(color: string | undefined, mode: DisplayMode): string | undefined {
  if (!color || mode === "light") {
    return color;
  }
  const metrics = getColorMetrics(color);
  if (!metrics || metrics.luminance >= 0.76) {
    return color;
  }

  const palette = getDisplayPalette(mode);
  if (metrics.luminance < 0.24) {
    return palette.text;
  }
  return metrics.saturation > 0.2 ? palette.accentText : palette.mutedText;
}

function themedViewStyle(
  style: ViewProps["style"],
  mode: DisplayMode,
): ViewProps["style"] {
  if (mode === "light") {
    return style;
  }
  const flattened = StyleSheet.flatten(style);
  if (!flattened) {
    return style;
  }

  const palette = getDisplayPalette(mode);
  const result = { ...flattened };
  const background = getColorMetrics(result.backgroundColor ?? "");
  if (background) {
    if (background.luminance > 0.78) {
      result.backgroundColor = palette.surface;
    } else if (background.luminance > 0.42) {
      result.backgroundColor = palette.raisedSurface;
    } else if (background.saturation > 0.12 && background.luminance < 0.36) {
      result.backgroundColor = palette.darkAccent;
    } else if (background.luminance < 0.18) {
      result.backgroundColor = palette.darkSurface;
    }
  }

  for (const key of ["borderColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"] as const) {
    if (result[key]) {
      result[key] = palette.border;
    }
  }
  return result;
}

function Text(props: TextProps) {
  const mode = useContext(DisplayModeContext);
  const flattened = StyleSheet.flatten(props.style);
  const style =
    mode === "light" || !flattened
      ? props.style
      : {
          ...flattened,
          color: themedTextColor(flattened.color ?? getDisplayPalette(mode).text, mode),
        };
  return <NativeText {...props} style={style} />;
}

function View(props: ViewProps) {
  const mode = useContext(DisplayModeContext);
  return <NativeView {...props} style={themedViewStyle(props.style, mode)} />;
}

function Pressable(props: PressableProps) {
  const mode = useContext(DisplayModeContext);
  const pressableStyle = props.style;
  const style =
    typeof pressableStyle === "function"
      ? (state: Parameters<NonNullable<PressableProps["style"]>>[0]) =>
          themedViewStyle(pressableStyle(state), mode)
      : themedViewStyle(pressableStyle, mode);
  return <NativePressable {...props} style={style} />;
}

function TextInput(props: TextInputProps) {
  const mode = useContext(DisplayModeContext);
  const flattened = StyleSheet.flatten(props.style);
  const style =
    mode === "light" || !flattened
      ? props.style
      : {
          ...flattened,
          color: themedTextColor(flattened.color ?? getDisplayPalette(mode).text, mode),
        };
  return (
    <NativeTextInput
      {...props}
      placeholderTextColor={themedTextColor(props.placeholderTextColor, mode)}
      style={style}
    />
  );
}

const workspaceTabs = [
  { id: "story", label: "Story", hint: "Import and convert" },
  { id: "cast", label: "Characters", hint: "Review speakers" },
  { id: "sound", label: "Sound", hint: "Shape the mood" },
  { id: "chapters", label: "Chapters", hint: "Plan the book" },
  { id: "player", label: "Listen", hint: "Play the result" },
] as const;
type WorkspaceTab = (typeof workspaceTabs)[number]["id"];

type LibraryEntry = {
  title: string;
  preview: string;
  storyText: string;
  lastOpenedAt: string;
};

function summarizeStory(storyText: string): string {
  const compactText = storyText.replace(/\s+/g, " ").trim();
  return compactText.length > 110 ? `${compactText.slice(0, 110).trim()}…` : compactText;
}

function buildGeneratedCues(bookName: string, chapterCountValue: string): PlaybackCue[] {
  const rawChapterCount = Number.parseInt(chapterCountValue || "1", 10);
  const safeChapterCount = Number.isFinite(rawChapterCount)
    ? Math.max(1, Math.min(rawChapterCount, 12))
    : 1;

  const speakers: Array<PlaybackCue["speaker"]> = ["Narrator", "Milo", "Elara", "Gideon"];
  const tones: PlaybackCue["tone"][] = ["warm", "bright", "calm", "dramatic"];

  return Array.from({ length: safeChapterCount }, (_, chapterIndex) => {
    const speaker = speakers[chapterIndex % speakers.length];
    const text = `${bookName} chapter ${chapterIndex + 1}: ${speaker === "Narrator" ? "The story unfolds with a sense of wonder, mystery, and momentum as the adventure continues." : `${speaker} steps forward with confidence and purpose as the next turning point begins.`}`;

    return {
      id: `${bookName}-${chapterIndex + 1}`,
      speaker,
      text,
      timestamp: `00:${String((chapterIndex + 1) * 12).padStart(2, "0")}`,
      tone: tones[chapterIndex % tones.length],
    };
  });
}

function formatAudioTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
    totalSeconds % 60,
  ).padStart(2, "0")}`;
}

function buildStoryCues(
  storyText: string,
  chapterCountValue: string,
  chapterPlan?: string[],
): PlaybackCue[] {
  const sentences =
    storyText
      .match(/[^.!?\n]+(?:[.!?]+(?:["”’])?|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
  const plannedChapterSizes = chapterPlan?.map(
    (chapter) =>
      chapter.match(/[^.!?\n]+(?:[.!?]+(?:["”’])?|$)/g)?.filter((line) => line.trim())
        .length ?? 0,
  ) ?? [];
  const hasValidChapterPlan =
    chapterPlan !== undefined &&
    plannedChapterSizes.length === chapterPlan.length &&
    plannedChapterSizes.every((size) => size > 0) &&
    plannedChapterSizes.reduce((total, size) => total + size, 0) === sentences.length;
  const plannedChapterEnds = hasValidChapterPlan
    ? plannedChapterSizes.reduce<number[]>((ends, size) => {
        ends.push((ends.at(-1) ?? 0) + size);
        return ends;
      }, [])
    : [];
  const rawChapterCount = Number.parseInt(chapterCountValue || "1", 10);
  const requestedCount = Number.isFinite(rawChapterCount)
    ? Math.max(1, Math.min(rawChapterCount, 12))
    : 1;
  const chapterTotal = Math.min(requestedCount, sentences.length);

  return sentences.map((sentence, sentenceIndex) => {
    const plannedChapterIndex = plannedChapterEnds.findIndex(
      (chapterEnd) => sentenceIndex < chapterEnd,
    );
    const chapterNumber =
      plannedChapterIndex >= 0
        ? plannedChapterIndex + 1
        : Math.min(
            chapterTotal,
            Math.floor((sentenceIndex * chapterTotal) / sentences.length) + 1,
          );
    const elapsedSeconds = Math.round(
      (sentences
        .slice(0, sentenceIndex)
        .join(" ")
        .split(/\s+/)
        .filter(Boolean).length /
        150) *
        60,
    );

    return {
      id: `pasted-story-${sentenceIndex + 1}`,
      speaker: "Narrator",
      text: sentence,
      timestamp: `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`,
      tone: "warm",
      chapterNumber,
    };
  });
}

export function HomeScreen() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("story");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("light");
  const [displayModeMessage, setDisplayModeMessage] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [apiUrlDraft, setApiUrlDraft] = useState("");
  const [apiStatus, setApiStatus] = useState("Checking API connection…");
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [isSavingApiUrl, setIsSavingApiUrl] = useState(false);
  const [chapterCount, setChapterCount] = useState("1");
  const [chapterPlan, setChapterPlan] = useState<string[]>([]);
  const [chapterPlanDrafts, setChapterPlanDrafts] = useState<string[]>([]);
  const [isSuggestingChapters, setIsSuggestingChapters] = useState(false);
  const [chapterPlanMessage, setChapterPlanMessage] = useState("");
  const [voiceStyle, setVoiceStyle] = useState<NarrationStyle>("gentle");
  const [book, setBook] = useState<PickedBook | null>(null);
  const [pastedStory, setPastedStory] = useState("");
  const [pastedBookTitle, setPastedBookTitle] = useState("");
  const [activeStoryText, setActiveStoryText] = useState("");
  const [activeBookTitle, setActiveBookTitle] = useState("");
  const [storyAnalysis, setStoryAnalysis] = useState<StoryAnalysis | null>(null);
  const [libraryBooks, setLibraryBooks] = useState<LibraryEntry[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [narrationScript, setNarrationScript] = useState<NarrationScript | null>(null);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [storyStatus, setStoryStatus] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeCueIndex, setActiveCueIndex] = useState(0);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [conversionStage, setConversionStage] = useState<
    "uploading" | "rendering" | "loading" | null
  >(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [conversionError, setConversionError] = useState("");
  const [playbackMessage, setPlaybackMessage] = useState("");
  const [speedIndex, setSpeedIndex] = useState(1);
  const [loopAudio, setLoopAudio] = useState(false);
  const [isReaderOpen, setIsReaderOpen] = useState(false);
  const [isLyricsFullscreen, setIsLyricsFullscreen] = useState(false);
  const [readerFontSize, setReaderFontSize] = useState(22);
  const audioPlayer = useAudioPlayer(null, { updateInterval: 100 });
  const audioStatus = useAudioPlayerStatus(audioPlayer);
  const audioTimingsRef = useRef<GeneratedAudio["timings"]>([]);
  const durationRef = useRef(0);
  const lyricScrollRef = useRef<ScrollViewInstance>(null);
  const lyricOffsets = useRef<Record<number, number>>({});
  const fullScreenLyricScrollRef = useRef<ScrollViewInstance>(null);
  const fullScreenLyricOffsets = useRef<Record<number, number>>({});
  const displayModeTouched = useRef(false);
  const progressWidth = useRef(0);
  const conversionPulse = useRef(new Animated.Value(0.35)).current;
  const displayPalette = useMemo(() => getDisplayPalette(displayMode), [displayMode]);

  useEffect(() => {
    let isMounted = true;
    async function checkApiConnection() {
      try {
        const savedApiUrl = await getApiBaseUrl();
        if (isMounted) {
          setApiUrl(savedApiUrl);
          setApiUrlDraft(savedApiUrl);
        }
        await getApiHealth();
        if (isMounted) {
          setApiStatus("Connected");
        }
      } catch (error) {
        if (isMounted) {
          setApiStatus(
            error instanceof Error ? error.message : "Unable to check the API connection.",
          );
        }
      }
    }

    void checkApiConnection();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function loadDisplayMode() {
      try {
        const savedMode = await AsyncStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
        if (
          isMounted &&
          !displayModeTouched.current &&
          isDisplayMode(savedMode)
        ) {
          setDisplayMode(savedMode);
        }
      } catch (error) {
        if (isMounted) {
          setDisplayModeMessage(
            `Unable to load display preference: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    void loadDisplayMode();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function loadLibrary() {
      try {
        const savedLibrary = await AsyncStorage.getItem(LIBRARY_STORAGE_KEY);
        if (!savedLibrary) {
          return;
        }
        const parsedLibrary = JSON.parse(savedLibrary) as LibraryEntry[];
        if (!Array.isArray(parsedLibrary) || !isMounted) {
          return;
        }
        setLibraryBooks(
          parsedLibrary.filter(
            (entry) =>
              typeof entry?.title === "string" &&
              typeof entry?.storyText === "string" &&
              typeof entry?.lastOpenedAt === "string",
          ),
        );
      } catch {
        if (isMounted) {
          setLibraryBooks([]);
        }
      }
    }

    void loadLibrary();
    return () => {
      isMounted = false;
    };
  }, []);

  async function persistLibraryEntry(title: string, storyText: string) {
    const normalizedTitle = title.trim() || "Untitled story";
    const normalizedStory = storyText.trim();
    if (!normalizedStory) {
      return;
    }

    const entry: LibraryEntry = {
      title: normalizedTitle,
      preview: summarizeStory(normalizedStory),
      storyText: normalizedStory,
      lastOpenedAt: new Date().toISOString(),
    };

    setLibraryBooks((current) => {
      const deduped = current.filter(
        (item) =>
          item.title !== normalizedTitle || item.storyText !== normalizedStory,
      );
      const nextLibrary = [entry, ...deduped].slice(0, MAX_LIBRARY_ITEMS);
      void AsyncStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(nextLibrary)).catch(() => {
        // Keep the in-memory library working even if persistence is unavailable.
      });
      return nextLibrary;
    });
  }

  async function openLibraryBook(entry: LibraryEntry) {
    setBook(null);
    setPastedStory(entry.storyText);
    setPastedBookTitle(entry.title);
    setActiveStoryText(entry.storyText);
    setActiveBookTitle(entry.title);
    setChapterPlan([]);
    setChapterPlanMessage("");
    setStoryAnalysis(null);
    setNarrationScript(null);
    setAnalysisMessage("");
    setImportError("");
    setConversionError("");
    setPlaybackMessage("");
    setStoryStatus(
      `${buildStoryCues(entry.storyText, chapterCount).length} sentence lines ready in ${entry.title}.`,
    );
    setActiveCueIndex(0);
    await persistLibraryEntry(entry.title, entry.storyText);
  }

  async function removeLibraryBook(title: string, storyText: string) {
    setLibraryBooks((current) => {
      const nextLibrary = current.filter(
        (entry) => entry.title !== title || entry.storyText !== storyText,
      );
      void AsyncStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(nextLibrary)).catch(() => {
        // Ignore storage failures while cleaning up the recent list.
      });
      return nextLibrary;
    });
  }

  async function clearLibraryBooks() {
    setLibraryBooks([]);
    await AsyncStorage.removeItem(LIBRARY_STORAGE_KEY).catch(() => {
      // Ignore storage failures while clearing the recent list.
    });
  }

  const currentSpeed = playbackSpeeds[speedIndex];
  const bookTitle = useMemo(() => {
    if (activeStoryText) {
      return activeBookTitle || "Pasted story";
    }

    if (!book) {
      return "The Lantern Gate";
    }

    return book.name.replace(/\.(?:pdf|odt)$/i, "");
  }, [activeBookTitle, book, activeStoryText]);

  const generatedCues = useMemo(
    () => {
      if (!activeStoryText) {
        return buildGeneratedCues(bookTitle, chapterCount);
      }

      const cues = buildStoryCues(activeStoryText, chapterCount, chapterPlan);
      if (
        narrationScript &&
        narrationScript.lines.length <= cues.length
      ) {
        return cues.map((cue, index) => ({
          ...cue,
          speaker: narrationScript.lines[index]?.speaker ?? cue.speaker,
        }));
      }
      return cues;
    },
    [activeStoryText, bookTitle, chapterCount, chapterPlan, narrationScript],
  );

  useEffect(() => {
    if (!generatedCues.length) {
      return;
    }

    if (activeCueIndex >= generatedCues.length) {
      setActiveCueIndex(0);
    }
  }, [activeCueIndex, generatedCues]);

  const currentCue = generatedCues[activeCueIndex] ?? generatedCues[0];
  const progress = audioUrl ? audioProgress : 0;

  useEffect(() => {
    setActiveWordIndex(-1);
    const activeLineOffset = lyricOffsets.current[activeCueIndex];
    if (activeLineOffset !== undefined) {
      lyricScrollRef.current?.scrollTo({
        y: Math.max(0, activeLineOffset - 56),
        animated: true,
      });
    }
    const fullScreenLineOffset = fullScreenLyricOffsets.current[activeCueIndex];
    if (fullScreenLineOffset !== undefined) {
      fullScreenLyricScrollRef.current?.scrollTo({
        y: Math.max(0, fullScreenLineOffset - 56),
        animated: true,
      });
    }
  }, [activeCueIndex, isLyricsFullscreen]);

  useEffect(() => {
    if (!audioStatus.isLoaded) {
      if (audioStatus.error) {
        setPlaybackMessage(`Audio playback failed: ${audioStatus.error}`);
        setIsPlaying(false);
      }
      return;
    }

    const duration = audioStatus.duration;
    const position = audioStatus.currentTime;
    durationRef.current = duration;
    setAudioProgress(duration > 0 ? (position / duration) * 100 : 0);
    setIsPlaying(audioStatus.playing);

    const timings = audioTimingsRef.current;
    if (duration > 0 && timings.length > 0) {
      const positionSeconds = position;
      let cueIndex = timings.findIndex(
        (timing) =>
          positionSeconds >= timing.start && positionSeconds <= timing.end,
      );
      if (cueIndex < 0) {
        for (let index = timings.length - 1; index >= 0; index -= 1) {
          if (positionSeconds >= timings[index].start) {
            cueIndex = index;
            break;
          }
        }
      }

      if (cueIndex >= 0 && cueIndex < generatedCues.length) {
        const timing = timings[cueIndex];
        let wordIndex = -1;
        if (positionSeconds <= timing.end) {
          for (let index = 0; index < timing.wordStarts.length; index += 1) {
            if (timing.wordStarts[index] <= positionSeconds) {
              wordIndex = index;
            } else {
              break;
            }
          }
        }
        setActiveCueIndex(cueIndex);
        setActiveWordIndex(wordIndex);
      }
    }

    if (audioStatus.didJustFinish) {
      setIsPlaying(false);
    }
  }, [audioStatus, generatedCues.length]);

  useEffect(() => {
    if (!audioStatus.isLoaded) {
      return;
    }

    audioPlayer.setPlaybackRate(currentSpeed, "high");
  }, [audioPlayer, audioStatus.isLoaded, currentSpeed]);

  useEffect(() => {
    audioPlayer.loop = loopAudio;
  }, [audioPlayer, loopAudio]);

  useEffect(() => {
    if (conversionStage !== "rendering" && !isImporting) {
      conversionPulse.setValue(0.35);
      return;
    }

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(conversionPulse, {
          toValue: 1,
          duration: 650,
          useNativeDriver: true,
        }),
        Animated.timing(conversionPulse, {
          toValue: 0.35,
          duration: 650,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [conversionPulse, conversionStage, isImporting]);

  async function clearAudio() {
    audioPlayer.pause();
    audioPlayer.replace(null);
    setAudioUrl(null);
    setDownloadUrl(null);
    audioTimingsRef.current = [];
    durationRef.current = 0;
    setAudioProgress(0);
    setIsPlaying(false);
    setActiveWordIndex(-1);
  }

  async function saveApiAddress() {
    setIsSavingApiUrl(true);
    setApiStatus("Saving API address…");
    try {
      await setApiBaseUrl(apiUrlDraft);
      const savedApiUrl = await getApiBaseUrl();
      setApiUrl(savedApiUrl);
      setApiUrlDraft(savedApiUrl);
      await getApiHealth();
      setApiStatus("Connected");
    } catch (error) {
      setApiStatus(
        error instanceof Error ? error.message : "Unable to save or reach the API.",
      );
    } finally {
      setIsSavingApiUrl(false);
    }

    async function chooseDisplayMode(mode: DisplayMode) {
      displayModeTouched.current = true;
      setDisplayMode(mode);
      setDisplayModeMessage("");
      try {
        await AsyncStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
      } catch (error) {
        setDisplayModeMessage(
          `Unable to save display preference: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async function chooseBook() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.oasis.opendocument.text",
          "text/plain",
          "text/markdown",
          "text/html",
          "image/*",
        ],
        copyToCacheDirectory: true,
        base64: false,
      });

      if (result.canceled) {
        return;
      }
      const file = result.assets[0];
      setBook({ name: file.name, uri: file.uri, size: file.size });
      setActiveStoryText("");
      setChapterPlan([]);
      setChapterPlanDrafts([]);
      setChapterPlanMessage("");
      setPastedStory("");
      setImportError("");
      setStoryStatus("");
      setIsImporting(true);
      try {
        await clearAudio();
        const title = file.name.replace(
          /\.(?:pdf|odt|docx|html?|md|markdown|txt|text|bmp|jpe?g|png|tiff?|webp)$/i,
          "",
        );
        const imported = await importStoryDocument(file);
        setPastedStory(imported.text);
        setPastedBookTitle(title);
        setActiveStoryText(imported.text);
        setActiveBookTitle(title);
        await persistLibraryEntry(title, imported.text);
        setStoryAnalysis(null);
        setNarrationScript(null);
        setAnalysisMessage("");
        setConversionError("");
        setPlaybackMessage("");
        setActiveCueIndex(0);
        setStoryStatus(
          `Imported ${imported.text.length.toLocaleString()} characters. Convert to audiobook when ready.`,
        );
      } catch (error) {
        setImportError(
          error instanceof Error ? error.message : "Unable to import this document.",
        );
      } finally {
        setIsImporting(false);
      }
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Unable to select a document.",
      );
    }
  }

  async function usePastedStory() {
    const trimmedStory = pastedStory.trim();
    if (!trimmedStory) {
      setStoryStatus("Paste some story text before preparing the preview.");
      return;
    }

    setBook(null);
    try {
      await clearAudio();
    } catch (error) {
      setPlaybackMessage(
        error instanceof Error ? error.message : "Unable to stop previous audio.",
      );
      return;
    }
    setActiveStoryText(trimmedStory);
    await persistLibraryEntry(pastedBookTitle.trim() || "Pasted story", trimmedStory);
    setChapterPlan([]);
    setChapterPlanDrafts([]);
    setChapterPlanMessage("");
    setActiveBookTitle(pastedBookTitle.trim() || "Pasted story");
    setStoryAnalysis(null);
    setNarrationScript(null);
    setAnalysisMessage("");
    setImportError("");
    setConversionError("");
    setPlaybackMessage("");
    setActiveCueIndex(0);
    setStoryStatus(
      `${buildStoryCues(trimmedStory, chapterCount).length} sentence lines ready. Convert the story to create playable and downloadable audio.`,
    );
  }

  async function analyzeActiveStory() {
    if (!activeStoryText.trim()) {
      setAnalysisMessage("Choose Use pasted story before analyzing.");
      return;
    }

    setIsAnalyzing(true);
    setAnalysisMessage("");
    try {
      const result = await analyzeStory(
        activeStoryText,
        activeBookTitle || "Pasted story",
      );
      setStoryAnalysis(result);
      setNarrationScript(null);
      setAnalysisMessage("Analysis ready. Suggestions can be corrected and saved for this book.");
    } catch (error) {
      setAnalysisMessage(
        error instanceof Error ? error.message : "Story analysis failed.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function createNarrationScript() {
    if (!activeStoryText.trim()) {
      setAnalysisMessage("Choose Use pasted story before generating a script.");
      return;
    }

    setIsGeneratingScript(true);
    setAnalysisMessage("");
    try {
      const result = await generateNarrationScript(
        activeStoryText,
        activeBookTitle || "Pasted story",
      );
      setNarrationScript(result);
      setAnalysisMessage("Script ready. Voice profiles are assigned for this book and can be changed below.");
    } catch (error) {
      setAnalysisMessage(
        error instanceof Error ? error.message : "Script generation failed.",
      );
    } finally {
      setIsGeneratingScript(false);
    }
  }

  async function suggestChapters() {
    if (!activeStoryText.trim()) {
      setChapterPlanMessage("Import or prepare a story before suggesting chapter breaks.");
      return;
    }

    setIsSuggestingChapters(true);
    setChapterPlanMessage("");
    try {
      const requestedCount = Number.parseInt(chapterCount || "1", 10);
      const result = await suggestChapterPlan(
        activeStoryText,
        Number.isFinite(requestedCount)
          ? Math.max(1, Math.min(requestedCount, 12))
          : 1,
      );
      setChapterPlan(result.chapters);
      setChapterPlanDrafts(result.chapters.map((chapter) => chapter.trim()));
      setChapterCount(String(result.chapterCount));
      setChapterPlanMessage(
        `${result.chapterCount} suggested chapter${result.chapterCount === 1 ? "" : "s"} ready. The plan will be used when you convert.`,
      );
    } catch (error) {
      setChapterPlanMessage(
        error instanceof Error ? error.message : "Unable to suggest chapter breaks.",
      );
    } finally {
      setIsSuggestingChapters(false);
    }
  }

  function updateChapterPlanDraft(index: number, value: string) {
    setChapterPlanDrafts((current) => {
      const nextDrafts = [...current];
      nextDrafts[index] = value;
      return nextDrafts;
    });
    setChapterPlan((current) => {
      const nextPlan = [...current];
      nextPlan[index] = value;
      return nextPlan;
    });
  }

  async function updateVoiceProfile(speaker: string) {
    if (!narrationScript) {
      return;
    }

    const currentProfile = narrationScript.lines.find(
      (line) => line.speaker === speaker,
    )?.voiceProfile;
    if (!currentProfile) {
      return;
    }
    const currentIndex = voiceProfileOptions.findIndex(
      (profile) => profile.id === currentProfile,
    );
    const nextProfile = voiceProfileOptions[(currentIndex + 1) % voiceProfileOptions.length];

    try {
      await saveAnalysisFeedback(
        activeBookTitle || "Pasted story",
        "voice_profile",
        speaker,
        nextProfile.id,
      );
      setNarrationScript((current) =>
        current
          ? {
              ...current,
              lines: current.lines.map((line) =>
                line.speaker === speaker
                  ? { ...line, voiceProfile: nextProfile.id }
                  : line,
              ),
            }
          : current,
      );
      setAnalysisMessage(`Saved ${nextProfile.label} voice for ${speaker} in this book.`);
      setPlaybackMessage("Voice profile saved. Convert the story again to apply it to the audio.");
    } catch (error) {
      setAnalysisMessage(
        error instanceof Error ? error.message : "Unable to save the voice profile.",
      );
    }
  }

  async function updateSegmentFeedback(
    index: number,
    category: "speaker" | "emotion",
  ) {
    if (!storyAnalysis) {
      return;
    }
    const segment = storyAnalysis.segments[index];
    const options =
      category === "speaker"
        ? [
            "Narrator",
            ...storyAnalysis.characters.map((character) => character.name),
            "Unidentified speaker",
          ]
        : ["neutral", "happy", "sad", "angry", "afraid", "curious", "excited", "warm"];
    const currentValue = category === "speaker" ? segment.speaker : segment.emotion;
    const currentIndex = options.indexOf(currentValue);
    const correctedValue = options[(currentIndex + 1) % options.length];

    try {
      await saveAnalysisFeedback(
        activeBookTitle || "Pasted story",
        category,
        segment.text,
        correctedValue,
      );
      setStoryAnalysis((current) => {
        if (!current) {
          return current;
        }
        const segments = current.segments.map((item, itemIndex) =>
          itemIndex === index ? { ...item, [category]: correctedValue } : item,
        );
        return { ...current, segments };
      });
      setNarrationScript(null);
      setAnalysisMessage(`Saved ${category} correction for this book.`);
    } catch (error) {
      setAnalysisMessage(
        error instanceof Error ? error.message : "Unable to save analysis feedback.",
      );
    }
  }

  async function updateMusicFeedback() {
    if (!storyAnalysis) {
      return;
    }
    const moods = ["calm", "wonder", "tense", "reflective", "mysterious", "joyful"];
    const currentIndex = moods.indexOf(storyAnalysis.music.mood);
    const correctedMood = moods[(currentIndex + 1) % moods.length];

    try {
      await saveAnalysisFeedback(
        activeBookTitle || "Pasted story",
        "music_mood",
        "",
        correctedMood,
      );
      setStoryAnalysis((current) =>
        current
          ? { ...current, music: { ...current.music, mood: correctedMood } }
          : current,
      );
      setIsAnalyzing(true);
      try {
        const refreshedAnalysis = await analyzeStory(
          activeStoryText,
          activeBookTitle || "Pasted story",
        );
        setStoryAnalysis(refreshedAnalysis);
      } catch (error) {
        setAnalysisMessage(
          `Preference saved, but refreshing the cue failed: ${
            error instanceof Error ? error.message : "analysis failed."
          }`,
        );
        return;
      } finally {
        setIsAnalyzing(false);
      }
      setAnalysisMessage("Saved soundtrack mood preference for this book.");
    } catch (error) {
      setAnalysisMessage(
        error instanceof Error ? error.message : "Unable to save music feedback.",
      );
    }
  }

  async function convertStoryToAudio() {
    if (!activeStoryText.trim()) {
      setPlaybackMessage("Paste or import your story before converting.");
      return;
    }

    setIsConverting(true);
    setConversionStage("uploading");
    setUploadProgress(0);
    setConversionError("");
    setPlaybackMessage("");
    try {
      await clearAudio();
      const requestedChapters = Number.parseInt(chapterCount || "1", 10);
      const scriptLines = narrationScript?.lines;
      const chaptersToRender =
        chapterPlan.length === Number(chapterCount) ? chapterPlan : undefined;
      const result = await generateAudio(
        activeStoryText,
        bookTitle,
        Number.isFinite(requestedChapters)
          ? Math.max(1, Math.min(requestedChapters, 12))
          : 1,
        (progress) => {
          setUploadProgress(progress);
          if (progress === 100) {
            setConversionStage("rendering");
          }
        },
        voiceStyle,
        scriptLines,
        chaptersToRender,
      );
      audioTimingsRef.current = result.timings;
      setAudioUrl(result.audioUrl);
      setDownloadUrl(result.downloadUrl);
      setConversionStage("loading");

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "mixWithOthers",
        shouldRouteThroughEarpiece: false,
      });
      audioPlayer.volume = 1;
      audioPlayer.loop = loopAudio;
      await new Promise<void>((resolve, reject) => {
        let subscription: { remove: () => void } | undefined;
        subscription = audioPlayer.addListener(
          "playbackStatusUpdate",
          (status: AudioStatus) => {
            if (status.isLoaded || status.error) {
              subscription?.remove();
              if (status.error) {
                reject(new Error(status.error));
              } else {
                resolve();
              }
            }
          },
        );
        try {
          audioPlayer.replace(result.audioUrl);
        } catch (error) {
          subscription.remove();
          reject(error);
        }
      });
      audioPlayer.setPlaybackRate(currentSpeed, "high");
      setStoryStatus(
        `Audiobook ready: ${result.chapters} chapter${result.chapters === 1 ? "" : "s"}${scriptLines?.length ? ` with character profiles on the first ${scriptLines.length} sentences` : ""}. Tap Play to listen.`,
      );
      setPlaybackMessage(
        "Tap Play to listen through your selected audio output. Check your device volume and Bluetooth output if it is silent.",
      );
      setActiveTab("player");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Audio conversion failed.";
      setConversionError(message);
      setPlaybackMessage(message);
    } finally {
      setIsConverting(false);
      setConversionStage(null);
    }
  }

  async function handlePlayToggle() {
    if (!audioUrl) {
      setPlaybackMessage("Convert the story to audio before pressing play.");
      return;
    }

    try {
      if (!audioStatus.isLoaded) {
        setPlaybackMessage(audioStatus.error ?? "Audio is not ready yet.");
        return;
      }

      if (audioStatus.playing) {
        audioPlayer.pause();
      } else {
        if (audioStatus.duration && audioStatus.currentTime >= audioStatus.duration) {
          await audioPlayer.seekTo(0);
        }
        audioPlayer.play();
      }
      setPlaybackMessage("");
    } catch (error) {
      setPlaybackMessage(
        error instanceof Error ? error.message : "Unable to control audio playback.",
      );
    }
  }

  async function seekToCue(index: number) {
    const boundedIndex = Math.max(0, Math.min(index, generatedCues.length - 1));
    setActiveCueIndex(boundedIndex);
    setActiveWordIndex(-1);
    const timing = audioTimingsRef.current[boundedIndex];
    if (timing && durationRef.current > 0) {
      try {
        await audioPlayer.seekTo(timing.start);
      } catch (error) {
        setPlaybackMessage(
          error instanceof Error ? error.message : "Unable to seek to that sentence.",
        );
      }
    }
  }

  async function seekProgress(locationX: number) {
    if (!audioUrl || progressWidth.current <= 0 || generatedCues.length === 0) {
      setPlaybackMessage("Convert the story before seeking through audio.");
      return;
    }
    const ratio = Math.max(0, Math.min(1, locationX / progressWidth.current));
    if (durationRef.current > 0) {
      try {
        await audioPlayer.seekTo(ratio * durationRef.current);
      } catch (error) {
        setPlaybackMessage(
          error instanceof Error ? error.message : "Unable to seek through audio.",
        );
      }
    }
  }

  async function downloadAudio() {
    if (!downloadUrl) {
      setPlaybackMessage("Convert the story before downloading audio.");
      return;
    }
    try {
      await Linking.openURL(downloadUrl);
    } catch (error) {
      setPlaybackMessage(
        error instanceof Error ? error.message : "Unable to open the audio download.",
      );
    }
  }

  return (
    <DisplayModeContext.Provider value={displayMode}>
      <StatusBar hidden={isReaderOpen || isLyricsFullscreen} />
      <ScrollView
        style={[styles.scrollView, { backgroundColor: displayPalette.background }]}
        contentContainerStyle={styles.scrollContent}
      >
      <View style={styles.screen}>
        <View style={styles.welcomeCard}>
          <View style={styles.welcomeCopy}>
            <Text style={styles.eyebrow}>YOUR STORYBOOK ATELIER</Text>
            <Text style={styles.title}>Stories, softly brought to life.</Text>
            <Text style={styles.description}>
              Turn a favorite story into a warm, character-filled audiobook.
            </Text>
          </View>
          <View accessible={false} style={styles.welcomeArt}>
            <View style={styles.welcomeMoon} />
            <Text style={styles.welcomeSparkle}>✦</Text>
            <View style={styles.welcomeBook}>
              <View style={styles.welcomeBookSpine} />
              <View style={styles.welcomeBookPage} />
            </View>
          </View>
        </View>

        <View style={styles.apiSettingsCard}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: apiSettingsOpen }}
            onPress={() => setApiSettingsOpen((open) => !open)}
            style={styles.apiSettingsHeader}
          >
            <View style={styles.apiSettingsHeading}>
              <Text style={styles.apiSettingsTitle}>API server</Text>
              <Text style={styles.apiSettingsUrl} numberOfLines={1}>
                {apiUrl || "Loading address…"}
              </Text>
            </View>
            <Text style={styles.apiSettingsAction}>
              {apiSettingsOpen ? "Close" : "Change"}
            </Text>
          </Pressable>
          <Text
            accessibilityRole="alert"
            style={[
              styles.apiStatus,
              apiStatus === "Connected" && styles.apiStatusConnected,
            ]}
          >
            {apiStatus}
          </Text>
          {apiSettingsOpen ? (
            <View>
              <Text style={styles.apiSettingsHint}>
                On a phone, enter your computer’s Wi-Fi address and port 8000 (for example,
                http://192.168.1.20:8000). Keep the API server running on that computer.
              </Text>
              <TextInput
                accessibilityLabel="API server address"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={setApiUrlDraft}
                onSubmitEditing={() => void saveApiAddress()}
                placeholder="http://192.168.1.20:8000"
                returnKeyType="done"
                style={styles.apiSettingsInput}
                value={apiUrlDraft}
              />
              <Pressable
                accessibilityRole="button"
                disabled={isSavingApiUrl || !apiUrlDraft.trim()}
                onPress={() => void saveApiAddress()}
                style={[
                  styles.apiSettingsButton,
                  (isSavingApiUrl || !apiUrlDraft.trim()) && styles.buttonDisabled,
                ]}
              >
                <Text style={styles.apiSettingsButtonText}>
                  {isSavingApiUrl ? "Saving and testing…" : "Save and test connection"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={styles.displaySettings}>
          <Text style={styles.displayModeTitle}>Display mode</Text>
          <View style={styles.displayModeOptions}>
            {displayModes.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: displayMode === option.id }}
                onPress={() => void chooseDisplayMode(option.id)}
                style={[
                  styles.displayModeOption,
                  displayMode === option.id && styles.displayModeOptionSelected,
                ]}
              >
                <Text
                  style={[
                    styles.displayModeOptionText,
                    displayMode === option.id && styles.displayModeOptionTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
          {displayModeMessage ? (
            <Text accessibilityRole="alert" style={styles.displayModeMessage}>
              {displayModeMessage}
            </Text>
          ) : null}
        </View>

        <View style={styles.workspaceTabs} accessibilityRole="tablist">
          {workspaceTabs.map((tab) => (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab.id }}
              onPress={() => setActiveTab(tab.id)}
              style={[
                styles.workspaceTab,
                activeTab === tab.id && styles.workspaceTabActive,
              ]}
            >
              <Text
                style={[
                  styles.workspaceTabLabel,
                  activeTab === tab.id && styles.workspaceTabLabelActive,
                ]}
              >
                {tab.label}
              </Text>
              <Text
                style={[
                  styles.workspaceTabHint,
                  activeTab === tab.id && styles.workspaceTabHintActive,
                ]}
              >
                {tab.hint}
              </Text>
            </Pressable>
          ))}
        </View>

        {activeTab === "story" ? (
          <View style={styles.workspacePanel}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              1. Add your story
            </Text>
            <Text style={styles.panelDescription}>
              Paste a chapter or choose a book to prepare it for narration.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Opens a file picker to select a PDF, Word, OpenDocument, HTML, Markdown, or plain text book"
              disabled={isImporting || isConverting}
              onPress={chooseBook}
              style={[styles.pickButton, (isImporting || isConverting) && styles.buttonDisabled]}
            >
              <Text style={styles.pickButtonText}>
                {isImporting
                  ? `Importing ${book?.name ?? "document"}…`
                  : book
                    ? `Selected: ${book.name}`
                    : "Choose a story file"}
              </Text>
            </Pressable>
            {isImporting ? (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="Importing story on the API server"
                style={styles.importProgressPanel}
              >
                <View style={styles.conversionHeading}>
                  <ActivityIndicator color="#9b5b80" size="small" />
                  <View style={styles.conversionCopy}>
                    <Text style={styles.conversionTitle}>Preparing your story</Text>
                    <Text style={styles.conversionDescription}>
                      The API server is extracting text from {book?.name ?? "your document"}.
                      Larger files may take a little while.
                    </Text>
                  </View>
                </View>
                <View style={styles.conversionTrack}>
                  <Animated.View
                    style={[
                      styles.conversionFill,
                      styles.conversionIndeterminate,
                      { opacity: conversionPulse },
                    ]}
                  />
                </View>
              </View>
            ) : null}
            {importError ? (
              <Text accessibilityRole="alert" style={styles.fileDetails}>
                {importError}
              </Text>
            ) : null}
            {storyStatus ? (
              <Text accessibilityRole="alert" style={styles.fileDetails}>
                {storyStatus}
              </Text>
            ) : null}
            {libraryBooks.length > 0 ? (
              <View style={styles.libraryPanel}>
                <View style={styles.libraryHeaderRow}>
                  <Text style={styles.libraryTitle}>Recent library</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void clearLibraryBooks()}
                    style={styles.libraryClearButton}
                  >
                    <Text style={styles.libraryClearText}>Clear all</Text>
                  </Pressable>
                </View>
                <View style={styles.libraryList}>
                  {libraryBooks.map((entry) => (
                    <View key={`${entry.title}-${entry.lastOpenedAt}`} style={styles.libraryCardWrap}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void openLibraryBook(entry)}
                        style={[
                          styles.libraryCard,
                          activeBookTitle === entry.title &&
                            activeStoryText === entry.storyText &&
                            styles.libraryCardActive,
                        ]}
                      >
                        <Text style={styles.libraryCardTitle}>{entry.title}</Text>
                        <Text style={styles.libraryCardPreview}>{entry.preview}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${entry.title} from recent library`}
                        onPress={() => void removeLibraryBook(entry.title, entry.storyText)}
                        style={styles.libraryRemoveButton}
                      >
                        <Text style={styles.libraryRemoveText}>Remove</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            <Text style={styles.fileDetails}>Narration style</Text>
            <View style={styles.voiceStyleRow}>
              {(
                [
                  ["gentle", "Gentle · softer default"],
                  ["expressive", "Expressive"],
                ] as const
              ).map(([style, label]) => (
                <Pressable
                  key={style}
                  accessibilityRole="button"
                  accessibilityState={{ selected: voiceStyle === style }}
                  disabled={isConverting}
                  onPress={() => setVoiceStyle(style)}
                  style={[
                    styles.voiceStyleButton,
                    voiceStyle === style && styles.voiceStyleButtonActive,
                    isConverting && styles.buttonDisabled,
                  ]}
                >
                  <Text
                    style={[
                      styles.voiceStyleButtonText,
                      voiceStyle === style && styles.voiceStyleButtonTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.actionRow}>
              {!activeStoryText || activeStoryText !== pastedStory.trim() ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={isImporting || isConverting || !pastedStory.trim()}
                  onPress={() => void usePastedStory()}
                  style={[
                    styles.secondaryButton,
                    (isImporting || isConverting || !pastedStory.trim()) &&
                      styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Use this story</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={isConverting || isImporting || !activeStoryText.trim()}
                onPress={() => void convertStoryToAudio()}
                style={[
                  styles.primaryButton,
                  (isConverting || isImporting || !activeStoryText.trim()) &&
                    styles.buttonDisabled,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {isConverting ? "Converting…" : "Convert to audiobook"}
                </Text>
              </Pressable>
            </View>
            {isConverting ? (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="Audiobook conversion progress"
                accessibilityValue={{
                  min: 0,
                  max: 100,
                  now:
                    conversionStage === "uploading"
                      ? uploadProgress
                      : conversionStage === "loading"
                        ? 100
                        : undefined,
                }}
                style={styles.conversionPanel}
              >
                <View style={styles.conversionHeading}>
                  <ActivityIndicator color="#8c4f3d" size="small" />
                  <View style={styles.conversionCopy}>
                    <Text style={styles.conversionTitle}>
                      {conversionStage === "uploading"
                        ? "Sending your story"
                        : conversionStage === "loading"
                          ? "Preparing your player"
                          : "Creating your audiobook"}
                    </Text>
                    <Text style={styles.conversionDescription}>
                      {conversionStage === "uploading"
                        ? `${uploadProgress}% uploaded`
                        : conversionStage === "loading"
                          ? "Audio is ready · opening the player"
                          : "Narration is being generated. Longer stories can take a little more time."}
                    </Text>
                  </View>
                </View>
                <View style={styles.conversionTrack}>
                  {conversionStage === "uploading" ? (
                    <View
                      style={[
                        styles.conversionFill,
                        { width: `${uploadProgress}%` },
                      ]}
                    />
                  ) : conversionStage === "loading" ? (
                    <View style={[styles.conversionFill, { width: "100%" }]} />
                  ) : (
                    <Animated.View
                      style={[
                        styles.conversionFill,
                        styles.conversionIndeterminate,
                        { opacity: conversionPulse },
                      ]}
                    />
                  )}
                </View>
              </View>
            ) : null}
            {conversionError ? (
              <View accessibilityRole="alert" style={styles.errorPanel}>
                <Text style={styles.errorTitle}>Audiobook creation failed</Text>
                <Text style={styles.errorText}>{conversionError}</Text>
                <Text style={styles.errorHint}>
                  Check that the API is running, then try again.
                </Text>
              </View>
            ) : null}

            <View style={styles.pastePanel}>
              <View style={styles.storyTextHeader}>
                <Text style={styles.pastePanelTitle}>Story text</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint="Opens the story in a distraction-free reading view"
                  disabled={!activeStoryText}
                  onPress={() => setIsReaderOpen(true)}
                  style={[
                    styles.readerModeButton,
                    !activeStoryText && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.readerModeButtonText}>Reading mode</Text>
                </Pressable>
              </View>
              <TextInput
                accessibilityLabel="Book title for saved AI preferences"
                onChangeText={(value) => {
                  setPastedBookTitle(value);
                  if (activeStoryText) {
                    setActiveBookTitle(value.trim() || "Pasted story");
                    setStoryAnalysis(null);
                    setNarrationScript(null);
                    setAnalysisMessage("");
                  }
                }}
                placeholder="Book title (used to remember corrections)"
                placeholderTextColor="#8c8178"
                style={styles.titleInput}
                value={pastedBookTitle}
              />
              <TextInput
                accessibilityLabel="Paste story text"
                multiline
                onChangeText={(value) => {
                  setPastedStory(value);
                  if (activeStoryText) {
                    setActiveStoryText(value);
                    setChapterPlan([]);
                    setChapterPlanMessage("");
                    setStoryAnalysis(null);
                    setNarrationScript(null);
                    setAnalysisMessage("");
                  }
                }}
                placeholder="Paste your story here..."
                placeholderTextColor="#8c8178"
                style={styles.storyInput}
                textAlignVertical="top"
                value={pastedStory}
              />
              {activeStoryText ? (
                <Text style={styles.fileDetails}>
                  Ready: {buildStoryCues(activeStoryText, chapterCount).length} sentence lines
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {activeTab === "cast" ? (
          <View style={styles.workspacePanel}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Character casting & narration script
            </Text>
            <Text style={styles.panelDescription}>
              Review suggested speakers and emotions, then build a script with delivery cues.
              Story wording is preserved; cues are suggestions.
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={isAnalyzing || !activeStoryText}
              onPress={() => void analyzeActiveStory()}
              style={[
                styles.primaryButton,
                (isAnalyzing || !activeStoryText) && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {isAnalyzing ? "Analyzing story…" : "Analyze characters & emotions"}
              </Text>
            </Pressable>
            {!activeStoryText ? (
              <Text style={styles.fileDetails}>
                Add and prepare a story in the Story section to begin.
              </Text>
            ) : null}
            {analysisMessage ? (
              <Text accessibilityRole="alert" style={styles.fileDetails}>
                {analysisMessage}
              </Text>
            ) : null}
            {storyAnalysis ? (
              <View style={styles.analysisPanel}>
                <Text style={styles.analysisTitle}>
                  {storyAnalysis.characters.length
                    ? storyAnalysis.characters
                        .map((character) => `${character.name} · ${character.mentions}`)
                        .join("   ")
                    : "No named characters detected"}
                </Text>
                <Text style={styles.analysisText}>
                  Narrator passages {storyAnalysis.narratorDetected ? "detected" : "not detected"} ·{" "}
                  {storyAnalysis.segmentsAnalyzed} lines analyzed
                </Text>
                {storyAnalysis.segments.slice(0, 12).map((segment, index) => (
                  <View key={`${index}-${segment.text}`} style={styles.analysisSegment}>
                    <Text style={styles.analysisSegmentText}>{segment.text}</Text>
                    <View style={styles.feedbackRow}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void updateSegmentFeedback(index, "speaker")}
                        style={styles.feedbackButton}
                      >
                        <Text style={styles.feedbackButtonText}>
                          Speaker · {segment.speaker} · change
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void updateSegmentFeedback(index, "emotion")}
                        style={styles.feedbackButton}
                      >
                        <Text style={styles.feedbackButtonText}>
                          Emotion · {segment.emotion} · change
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
                {storyAnalysis.truncated ? (
                  <Text style={styles.analysisText}>
                    Showing 12 of {storyAnalysis.totalSegments} lines.
                  </Text>
                ) : null}
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={isGeneratingScript || !activeStoryText}
              onPress={() => void createNarrationScript()}
              style={[
                styles.secondaryButton,
                (isGeneratingScript || !activeStoryText) && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {isGeneratingScript ? "Generating script…" : "Generate narration script"}
              </Text>
            </Pressable>
            {narrationScript ? (
              <View style={styles.analysisPanel}>
                <Text style={styles.analysisTitle}>Narration script</Text>
                <Text style={styles.analysisText}>
                  {narrationScript.lines.length} lines generated
                </Text>
                  <Text style={styles.analysisText}>
                    Voices stay consistent for this book. Change a speaker's voice below.
                  </Text>
                  {Array.from(new Set(narrationScript.lines.map((line) => line.speaker))).map(
                    (speaker) => {
                      const profile = voiceProfileOptions.find(
                        (option) =>
                          option.id ===
                          narrationScript.lines.find((line) => line.speaker === speaker)
                            ?.voiceProfile,
                      );
                      return (
                        <Pressable
                          key={speaker}
                          accessibilityRole="button"
                          accessibilityLabel={`Change ${speaker} voice profile`}
                          onPress={() => void updateVoiceProfile(speaker)}
                          style={styles.feedbackButton}
                        >
                          <Text style={styles.feedbackButtonText}>
                            {speaker} · {profile?.label ?? "Voice"} · change
                          </Text>
                        </Pressable>
                      );
                    },
                  )}
                  {narrationScript.lines.slice(0, 12).map((line) => (
                  <View key={line.number} style={styles.analysisSegment}>
                    <Text style={styles.analysisText}>
                      {line.number}. {line.speaker} · {line.delivery}
                    </Text>
                    <Text style={styles.analysisSegmentText}>{line.text}</Text>
                  </View>
                ))}
                {narrationScript.truncated || narrationScript.lines.length > 12 ? (
                  <Text style={styles.analysisText}>
                    Showing the first 12 of {narrationScript.totalLines} lines. Split long stories
                    into sections to generate a complete script.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {activeTab === "sound" ? (
          <View style={styles.workspacePanel}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Sound & emotion
            </Text>
            <Text style={styles.panelDescription}>
              Choose a soundtrack mood to shape the suggested score.
            </Text>
            {storyAnalysis ? (
              <View style={styles.soundCard}>
                <Text style={styles.soundMood}>{storyAnalysis.music.mood}</Text>
                <Text style={styles.soundStyle}>{storyAnalysis.music.style}</Text>
                <Text style={styles.fileDetails}>
                  Suggested intensity · {storyAnalysis.music.intensity}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void updateMusicFeedback()}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Try another mood</Text>
                </Pressable>
                <Text style={styles.analysisText}>
                  Mood choices are learned for this book. Audio tracks are not mixed yet.
                </Text>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateTitle}>Start with a story analysis</Text>
                <Text style={styles.panelDescription}>
                  The local model will suggest emotions and a matching music mood.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={isAnalyzing || !activeStoryText}
                  onPress={() => void analyzeActiveStory()}
                  style={[
                    styles.primaryButton,
                    (isAnalyzing || !activeStoryText) && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {isAnalyzing ? "Analyzing…" : "Analyze this story"}
                  </Text>
                </Pressable>
              </View>
            )}
            {analysisMessage ? (
              <Text accessibilityRole="alert" style={styles.fileDetails}>
                {analysisMessage}
              </Text>
            ) : null}
          </View>
        ) : null}

        {activeTab === "chapters" ? (
          <View style={styles.workspacePanel}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Chapter plan
            </Text>
            <Text style={styles.panelDescription}>
              Split your story into up to 12 chapters.
            </Text>
            <View style={styles.chapterSelector}>
              {[1, 2, 4, 6, 8, 12].map((count) => (
                <Pressable
                  key={count}
                  accessibilityRole="button"
                  accessibilityState={{ selected: Number(chapterCount) === count }}
                  onPress={() => {
                    setChapterCount(String(count));
                    setChapterPlan([]);
                    setChapterPlanDrafts([]);
                    setChapterPlanMessage("");
                  }}
                  style={[
                    styles.chapterChip,
                    Number(chapterCount) === count && styles.chapterChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.chapterChipText,
                      Number(chapterCount) === count && styles.chapterChipTextActive,
                    ]}
                  >
                    {count}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={
                isSuggestingChapters || isConverting || !activeStoryText.trim()
              }
              onPress={() => void suggestChapters()}
              style={[
                styles.secondaryButton,
                (isSuggestingChapters || isConverting || !activeStoryText.trim()) &&
                  styles.buttonDisabled,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {isSuggestingChapters ? "Planning chapters…" : "Suggest chapter breaks"}
              </Text>
            </Pressable>
            {chapterPlanMessage ? (
              <Text
                accessibilityRole={chapterPlan.length ? "text" : "alert"}
                style={styles.fileDetails}
              >
                {chapterPlanMessage}
              </Text>
            ) : null}
            {chapterPlan.length ? (
              <View style={styles.chapterPlanPreview}>
                {chapterPlan.map((chapter, index) => (
                  <View key={`chapter-plan-${index}`} style={styles.chapterPlanItem}>
                    <Text style={styles.chapterPlanTitle}>Chapter {index + 1}</Text>
                    <TextInput
                      accessibilityLabel={`Edit chapter ${index + 1} text`}
                      multiline
                      onChangeText={(value) => updateChapterPlanDraft(index, value)}
                      placeholder="Describe this chapter's focus"
                      placeholderTextColor="#8c8178"
                      style={styles.chapterPlanInput}
                      value={chapterPlanDrafts[index] ?? chapter}
                    />
                    <Text style={styles.chapterPlanText}>
                      {chapter.replace(/\s+/g, " ").trim()}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Text style={styles.fileDetails}>
              {chapterCount} chapter{chapterCount === "1" ? "" : "s"} ·{" "}
              {activeStoryText
                ? `${buildStoryCues(activeStoryText, chapterCount).length} story lines`
                : "Add a story to begin"}
            </Text>
            <View style={styles.posterCard}>
              <View style={[styles.posterGlow, styles.posterGlowOne]} />
              <View style={[styles.posterGlow, styles.posterGlowTwo]} />
              <Text style={styles.posterBadge}>Audio edition</Text>
              <Text style={styles.posterTitle}>{bookTitle}</Text>
              <Text style={styles.posterMeta}>Storybook Audio · {chapterCount} chapters</Text>
              <Text style={styles.posterAccent}>Your story, ready to be performed</Text>
            </View>
          </View>
        ) : null}

        {activeTab === "player" ? (
          <>
          {audioUrl ? (
        <View style={styles.playerCard}>
          <View style={styles.playerHeader}>
            <View>
              <Text style={styles.playerTag}>
                Chapter {currentCue?.chapterNumber ?? activeCueIndex + 1} · {activeCueIndex + 1} of {generatedCues.length} lines
              </Text>
              <Text style={styles.playerTitle}>{bookTitle}</Text>
            </View>
          </View>

          <Text style={styles.nowPlayingSpeaker}>{currentCue?.speaker ?? "Narrator"}</Text>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Audiobook playback position"
            onLayout={(event) => {
              progressWidth.current = event.nativeEvent.layout.width;
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Seek through story"
              onPress={(event) => void seekProgress(event.nativeEvent.locationX)}
              style={styles.progressTrack}
            >
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
            </Pressable>
          </View>
          <View style={styles.timelineLabels}>
            <Text style={styles.timelineText}>
              {formatAudioTime(
                audioTimingsRef.current[activeCueIndex]?.start ??
                  (currentCue?.timestamp
                    ? Number(currentCue.timestamp.slice(0, 2)) * 60 +
                      Number(currentCue.timestamp.slice(3, 5))
                    : 0),
              )}
            </Text>
            <Text style={styles.timelineText}>
              {generatedCues.length} sentence{generatedCues.length === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={styles.transportRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous sentence"
              onPress={() => void seekToCue(activeCueIndex - 1)}
              style={styles.transportButton}
            >
              <Text style={styles.transportButtonText}>|◀</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? "Pause narration" : "Play narration"}
              onPress={handlePlayToggle}
              style={styles.playButton}
            >
              <Text style={styles.playButtonText}>{isPlaying ? "Pause" : "Play"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next sentence"
              onPress={() => void seekToCue(activeCueIndex + 1)}
              style={styles.transportButton}
            >
              <Text style={styles.transportButtonText}>▶|</Text>
            </Pressable>
          </View>
          {playbackMessage ? (
            <Text accessibilityRole="alert" style={styles.playbackMessage}>
              {playbackMessage}
            </Text>
          ) : null}

          <View style={styles.speedRow}>
            <Text style={styles.controlLabel}>Speed</Text>
            <View style={styles.chipGroup}>
              {playbackSpeeds.map((speed, index) => (
                <Pressable
                  key={speed}
                  accessibilityRole="button"
                  onPress={() => setSpeedIndex(index)}
                  style={[
                    styles.speedChip,
                    speedIndex === index && styles.speedChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.speedChipText,
                      speedIndex === index && styles.speedChipTextActive,
                    ]}
                  >
                    {speed}x
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.toggleRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: loopAudio }}
              onPress={() => setLoopAudio((current) => !current)}
              style={[styles.toggleButton, loopAudio && styles.toggleButtonActive]}
            >
              <Text style={styles.toggleText}>Repeat audiobook</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!downloadUrl}
              onPress={() => void downloadAudio()}
              style={[styles.toggleButton, !downloadUrl && styles.buttonDisabled]}
            >
              <Text style={styles.toggleText}>Download WAV</Text>
            </Pressable>
          </View>

          <View style={styles.lyricsSection}>
            <View style={styles.lyricsHeader}>
              <Text style={styles.lyricsTitle}>Follow the story</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Opens synchronized lyrics in a full-screen view"
                onPress={() => setIsLyricsFullscreen(true)}
                style={styles.readerModeButton}
              >
                <Text style={styles.readerModeButtonText}>Full screen</Text>
              </Pressable>
            </View>
            <Text style={styles.lyricsHint}>
              The current sentence scrolls into view. Word highlighting follows the audio position.
            </Text>
            <ScrollView
              ref={lyricScrollRef}
              nestedScrollEnabled
              style={styles.lyricsScroll}
            >
              {generatedCues.map((cue, index) => (
                <View
                  key={cue.id}
                  onLayout={(event) => {
                    lyricOffsets.current[index] = event.nativeEvent.layout.y;
                  }}
                  style={[
                    styles.lyricRow,
                    activeCueIndex === index && styles.lyricRowActive,
                  ]}
                >
                  <View style={styles.lyricMeta}>
                    <Text style={styles.lyricSpeaker}>{cue.speaker}</Text>
                    <Text style={styles.lyricTime}>{cue.timestamp}</Text>
                  </View>
                  <Text style={styles.lyricText} accessibilityRole="text">
                    {[...cue.text.matchAll(/\S+\s*/g)].map(([word], wordIndex) => (
                      <Text
                        key={`${cue.id}-word-${wordIndex}`}
                        style={[
                          styles.lyricWord,
                          activeCueIndex === index &&
                            activeWordIndex === wordIndex &&
                            styles.lyricWordActive,
                        ]}
                      >
                        {word}
                      </Text>
                    ))}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateTitle}>Your player is waiting</Text>
              <Text style={styles.panelDescription}>
                Create an audiobook from the Story section to play it here.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setActiveTab("story")}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Go to your story</Text>
              </Pressable>
            </View>
          )}

        <View style={styles.note}>
          <Text style={styles.noteTitle}>About this audio</Text>
          <Text style={styles.noteText}>
            Local AI suggests character speakers, emotions, and soundtrack moods.
            Corrections are saved in the local API for the same book. Narration
            uses local neural voices; soundtrack suggestions do not include or
            play music tracks.
          </Text>
        </View>
          </>
        ) : null}
      </View>
      </ScrollView>
      <Modal
        animationType="slide"
        onRequestClose={() => setIsReaderOpen(false)}
        presentationStyle="fullScreen"
        visible={isReaderOpen}
      >
        <View style={styles.readerScreen}>
          <View style={styles.readerToolbar}>
            <Text style={styles.readerTitle} numberOfLines={1}>
              {bookTitle}
            </Text>
            <View style={styles.readerToolbarActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decrease reading text size"
                accessibilityState={{ disabled: readerFontSize <= 16 }}
                disabled={readerFontSize <= 16}
                onPress={() => setReaderFontSize((size) => Math.max(16, size - 2))}
                style={styles.readerActionButton}
              >
                <Text style={styles.readerActionText}>A−</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Increase reading text size"
                accessibilityState={{ disabled: readerFontSize >= 32 }}
                disabled={readerFontSize >= 32}
                onPress={() => setReaderFontSize((size) => Math.min(32, size + 2))}
                style={styles.readerActionButton}
              >
                <Text style={styles.readerActionText}>A+</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setIsReaderOpen(false)}
                style={styles.readerActionButton}
              >
                <Text style={styles.readerActionText}>Done</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.readerScrollContent}>
            <Text
              style={[
                styles.readerText,
                { fontSize: readerFontSize, lineHeight: readerFontSize * 1.65 },
              ]}
            >
              {activeStoryText}
            </Text>
          </ScrollView>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => setIsLyricsFullscreen(false)}
        presentationStyle="fullScreen"
        visible={isLyricsFullscreen}
      >
        <View style={styles.readerScreen}>
          <View style={styles.readerToolbar}>
            <View style={styles.fullScreenLyricsHeading}>
              <Text style={styles.readerTitle} numberOfLines={1}>
                Lyrics
              </Text>
              <Text style={styles.fullScreenLyricsBook} numberOfLines={1}>
                {bookTitle}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => setIsLyricsFullscreen(false)}
              style={styles.readerActionButton}
            >
              <Text style={styles.readerActionText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            ref={fullScreenLyricScrollRef}
            contentContainerStyle={styles.fullScreenLyricsContent}
          >
            {generatedCues.map((cue, index) => (
              <View
                key={cue.id}
                onLayout={(event) => {
                  const offset = event.nativeEvent.layout.y;
                  fullScreenLyricOffsets.current[index] = offset;
                  if (index === activeCueIndex) {
                    fullScreenLyricScrollRef.current?.scrollTo({
                      y: Math.max(0, offset - 56),
                      animated: true,
                    });
                  }
                }}
                style={[
                  styles.lyricRow,
                  activeCueIndex === index && styles.lyricRowActive,
                ]}
              >
                <View style={styles.lyricMeta}>
                  <Text style={styles.lyricSpeaker}>{cue.speaker}</Text>
                  <Text style={styles.lyricTime}>{cue.timestamp}</Text>
                </View>
                <Text style={styles.fullScreenLyricText} accessibilityRole="text">
                  {[...cue.text.matchAll(/\S+\s*/g)].map(([word], wordIndex) => (
                    <Text
                      key={`${cue.id}-full-screen-word-${wordIndex}`}
                      style={[
                        styles.lyricWord,
                        activeCueIndex === index &&
                          activeWordIndex === wordIndex &&
                          styles.lyricWordActive,
                      ]}
                    >
                      {word}
                    </Text>
                  ))}
                </Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.fullScreenTransport}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous sentence"
              onPress={() => void seekToCue(activeCueIndex - 1)}
              style={styles.transportButton}
            >
              <Text style={styles.transportButtonText}>|◀</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? "Pause narration" : "Play narration"}
              onPress={handlePlayToggle}
              style={styles.playButton}
            >
              <Text style={styles.playButtonText}>{isPlaying ? "Pause" : "Play"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next sentence"
              onPress={() => void seekToCue(activeCueIndex + 1)}
              style={styles.transportButton}
            >
              <Text style={styles.transportButtonText}>▶|</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </DisplayModeContext.Provider>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    backgroundColor: "#fff9f7",
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  screen: {
    alignSelf: "center",
    backgroundColor: "#fff9f7",
    flex: 1,
    maxWidth: 720,
    padding: 28,
    width: "100%",
  },
  welcomeCard: {
    alignItems: "center",
    backgroundColor: "#f7eaf1",
    borderColor: "#edd8e5",
    borderRadius: 26,
    borderWidth: 1,
    flexDirection: "row",
    marginBottom: 18,
    marginTop: 16,
    minHeight: 206,
    overflow: "hidden",
    padding: 20,
  },
  welcomeCopy: {
    flex: 1,
    zIndex: 1,
  },
  welcomeArt: {
    alignItems: "center",
    height: 138,
    justifyContent: "center",
    marginLeft: -10,
    position: "relative",
    width: 92,
  },
  welcomeMoon: {
    backgroundColor: "#f3d9bd",
    borderRadius: 70,
    height: 112,
    opacity: 0.9,
    position: "absolute",
    right: -28,
    top: 0,
    width: 132,
  },
  welcomeSparkle: {
    color: "#a65f83",
    fontSize: 24,
    position: "absolute",
    right: 6,
    top: 12,
  },
  welcomeBook: {
    backgroundColor: "#9b5b80",
    borderColor: "#fff8fb",
    borderRadius: 8,
    borderWidth: 3,
    height: 94,
    justifyContent: "center",
    marginTop: 34,
    position: "relative",
    transform: [{ rotate: "-8deg" }],
    width: 72,
  },
  welcomeBookSpine: {
    backgroundColor: "#754364",
    height: "100%",
    left: 10,
    position: "absolute",
    width: 3,
  },
  welcomeBookPage: {
    borderColor: "#f6dcb7",
    borderRadius: 999,
    borderTopWidth: 2,
    height: 20,
    marginLeft: 26,
    marginTop: -4,
    transform: [{ rotate: "-28deg" }],
    width: 20,
  },
  eyebrow: {
    color: "#9b5b80",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginTop: 0,
  },
  title: {
    color: "#44334c",
    fontSize: 27,
    fontWeight: "700",
    marginTop: 12,
  },
  description: {
    color: "#67566a",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 0,
    marginTop: 10,
  },
  apiSettingsCard: {
    backgroundColor: "#f5edf3",
    borderRadius: 18,
    marginBottom: 16,
    padding: 14,
  },
  apiSettingsHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  apiSettingsHeading: {
    flex: 1,
    marginRight: 12,
  },
  apiSettingsTitle: {
    color: "#3d342d",
    fontSize: 14,
    fontWeight: "700",
  },
  apiSettingsUrl: {
    color: "#655e56",
    fontSize: 12,
    marginTop: 3,
  },
  apiSettingsAction: {
    color: "#6d4c41",
    fontSize: 13,
    fontWeight: "700",
  },
  apiStatus: {
    color: "#8a4538",
    fontSize: 12,
    marginTop: 8,
  },
  apiStatusConnected: {
    color: "#426743",
  },
  apiSettingsHint: {
    color: "#655e56",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  apiSettingsInput: {
    backgroundColor: "#ffffff",
    borderColor: "#ded7ce",
    borderRadius: 8,
    borderWidth: 1,
    color: "#28231f",
    fontSize: 14,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  apiSettingsButton: {
    alignSelf: "flex-start",
    backgroundColor: "#6d4c41",
    borderRadius: 8,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  apiSettingsButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  displaySettings: {
    backgroundColor: "#f5edf3",
    borderRadius: 16,
    marginTop: 12,
    padding: 12,
  },
  displayModeTitle: {
    color: "#44334c",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  displayModeOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  displayModeOption: {
    backgroundColor: "#eee7df",
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  displayModeOptionSelected: {
    backgroundColor: "#9b5b80",
  },
  displayModeOptionText: {
    color: "#4b3027",
    fontSize: 12,
    fontWeight: "600",
  },
  displayModeOptionTextSelected: {
    color: "#ffffff",
  },
  displayModeMessage: {
    color: "#842e1b",
    fontSize: 12,
    marginTop: 8,
  },
  workspaceTabs: {
    backgroundColor: "#f0eaf3",
    borderRadius: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 8,
  },
  workspaceTab: {
    backgroundColor: "transparent",
    borderRadius: 11,
    flexGrow: 1,
    minWidth: 100,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  workspaceTabActive: {
    backgroundColor: "#fffafd",
    elevation: 1,
    shadowColor: "#352722",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  workspaceTabLabel: {
    color: "#655e56",
    fontSize: 14,
    fontWeight: "700",
  },
  workspaceTabLabelActive: {
    color: "#4b3027",
  },
  workspaceTabHint: {
    color: "#83766e",
    fontSize: 10,
    marginTop: 3,
  },
  workspaceTabHintActive: {
    color: "#795548",
  },
  workspacePanel: {
    marginTop: 10,
  },
  sectionTitle: {
    color: "#28231f",
    fontSize: 19,
    fontWeight: "700",
    marginBottom: 12,
    marginTop: 20,
  },
  panelDescription: {
    color: "#655e56",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 14,
  },
  pickButton: {
    alignSelf: "flex-start",
    backgroundColor: "#9b5b80",
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  pickButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  fileDetails: {
    color: "#655e56",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  libraryPanel: {
    backgroundColor: "#f7f1ea",
    borderColor: "#e4d7ca",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 16,
    padding: 12,
  },
  libraryHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  libraryTitle: {
    color: "#3d342d",
    fontSize: 14,
    fontWeight: "700",
  },
  libraryClearButton: {
    alignSelf: "flex-start",
    backgroundColor: "#efe4db",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  libraryClearText: {
    color: "#5a3c32",
    fontSize: 11,
    fontWeight: "700",
  },
  libraryList: {
    gap: 8,
  },
  libraryCardWrap: {
    flexDirection: "row",
    gap: 8,
  },
  libraryCard: {
    backgroundColor: "#ffffff",
    borderColor: "#e3d6c9",
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  libraryCardActive: {
    borderColor: "#6d4c41",
  },
  libraryCardTitle: {
    color: "#3d342d",
    fontSize: 13,
    fontWeight: "700",
  },
  libraryCardPreview: {
    color: "#655e56",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  libraryRemoveButton: {
    alignSelf: "center",
    backgroundColor: "#f2e1d6",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  libraryRemoveText: {
    color: "#6d4c41",
    fontSize: 11,
    fontWeight: "700",
  },
  voiceStyleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  voiceStyleButton: {
    backgroundColor: "#eee7df",
    borderColor: "#ded7ce",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  voiceStyleButtonActive: {
    backgroundColor: "#9b5b80",
    borderColor: "#9b5b80",
  },
  voiceStyleButtonText: {
    color: "#4b3027",
    fontSize: 13,
    fontWeight: "600",
  },
  voiceStyleButtonTextActive: {
    color: "#ffffff",
  },
  pastePanel: {
    backgroundColor: "#f0e9df",
    borderRadius: 14,
    marginTop: 20,
    padding: 18,
  },
  pastePanelTitle: {
    color: "#3d342d",
    fontSize: 17,
    fontWeight: "700",
  },
  storyTextHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  readerModeButton: {
    backgroundColor: "#eadce7",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  readerModeButtonText: {
    color: "#68405f",
    fontSize: 12,
    fontWeight: "700",
  },
  pastePanelDescription: {
    color: "#655e56",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  storyInput: {
    backgroundColor: "#ffffff",
    borderColor: "#ded7ce",
    borderRadius: 10,
    borderWidth: 1,
    color: "#28231f",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 14,
    minHeight: 180,
    padding: 14,
  },
  titleInput: {
    backgroundColor: "#ffffff",
    borderColor: "#ded7ce",
    borderRadius: 10,
    borderWidth: 1,
    color: "#28231f",
    fontSize: 15,
    marginTop: 14,
    padding: 12,
  },
  pasteButton: {
    alignSelf: "flex-start",
    backgroundColor: "#6d4c41",
    borderRadius: 10,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  pasteButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  convertButton: {
    alignSelf: "flex-start",
    backgroundColor: "#3d342d",
    borderRadius: 10,
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  convertButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  analyzeButton: {
    alignSelf: "flex-start",
    backgroundColor: "#795548",
    borderRadius: 10,
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  analyzeButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 12,
  },
  primaryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#554365",
    borderRadius: 14,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  secondaryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#f0e3ed",
    borderRadius: 14,
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: "#4b3027",
    fontSize: 14,
    fontWeight: "700",
  },
  conversionPanel: {
    backgroundColor: "#fffafd",
    borderColor: "#edd8e5",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 16,
    padding: 14,
  },
  importProgressPanel: {
    backgroundColor: "#fffafd",
    borderColor: "#edd8e5",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  conversionHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  conversionCopy: {
    flex: 1,
  },
  conversionTitle: {
    color: "#3d342d",
    fontSize: 14,
    fontWeight: "700",
  },
  conversionDescription: {
    color: "#655e56",
    fontSize: 12,
    marginTop: 3,
  },
  conversionTrack: {
    backgroundColor: "#f0e6f0",
    borderRadius: 99,
    height: 7,
    marginTop: 14,
    overflow: "hidden",
  },
  conversionFill: {
    backgroundColor: "#bd789a",
    borderRadius: 99,
    height: "100%",
  },
  conversionIndeterminate: {
    width: "38%",
  },
  errorPanel: {
    backgroundColor: "#fff1ed",
    borderColor: "#e8b9ac",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  errorTitle: {
    color: "#842e1b",
    fontSize: 14,
    fontWeight: "700",
  },
  errorText: {
    color: "#6b3024",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
  },
  errorHint: {
    color: "#875348",
    fontSize: 12,
    marginTop: 6,
  },
  analysisPanel: {
    backgroundColor: "#ffffff",
    borderColor: "#ded7ce",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  analysisTitle: {
    color: "#3d342d",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  analysisText: {
    color: "#655e56",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  analysisSegment: {
    borderTopColor: "#eee7df",
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 10,
  },
  analysisSegmentText: {
    color: "#3d342d",
    fontSize: 13,
    lineHeight: 19,
  },
  feedbackRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  feedbackButton: {
    alignSelf: "flex-start",
    backgroundColor: "#f0e9df",
    borderRadius: 8,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  feedbackButtonText: {
    color: "#3d342d",
    fontSize: 12,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  label: {
    color: "#655e56",
    fontSize: 14,
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#ffffff",
    borderColor: "#ded7ce",
    borderRadius: 10,
    borderWidth: 1,
    color: "#28231f",
    fontSize: 16,
    maxWidth: 220,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  chapterSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 6,
  },
  chapterChip: {
    alignItems: "center",
    backgroundColor: "#eee7df",
    borderRadius: 10,
    minWidth: 48,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  chapterChipActive: {
    backgroundColor: "#6d4c41",
  },
  chapterChipText: {
    color: "#4b3027",
    fontSize: 14,
    fontWeight: "700",
  },
  chapterChipTextActive: {
    color: "#ffffff",
  },
  chapterPlanPreview: {
    gap: 8,
    marginTop: 10,
  },
  chapterPlanItem: {
    backgroundColor: "#f0e9df",
    borderRadius: 10,
    padding: 12,
  },
  chapterPlanTitle: {
    color: "#4b3027",
    fontSize: 13,
    fontWeight: "700",
  },
  chapterPlanInput: {
    backgroundColor: "#ffffff",
    borderColor: "#ded7ce",
    borderRadius: 8,
    borderWidth: 1,
    color: "#28231f",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    minHeight: 70,
    padding: 10,
    textAlignVertical: "top",
  },
  chapterPlanText: {
    color: "#655e56",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  soundCard: {
    backgroundColor: "#3d3049",
    borderRadius: 22,
    marginTop: 12,
    padding: 20,
  },
  soundMood: {
    color: "#f6c7a4",
    fontSize: 24,
    fontWeight: "800",
    textTransform: "capitalize",
  },
  soundStyle: {
    color: "#fff7ef",
    fontSize: 17,
    lineHeight: 25,
    marginTop: 10,
  },
  emptyState: {
    backgroundColor: "#f5edf3",
    borderRadius: 20,
    marginTop: 20,
    padding: 20,
  },
  emptyStateTitle: {
    color: "#3d342d",
    fontSize: 18,
    fontWeight: "700",
  },
  posterCard: {
    backgroundColor: "#392c46",
    borderRadius: 26,
    height: 180,
    marginTop: 26,
    overflow: "hidden",
    padding: 18,
    position: "relative",
  },
  posterGlow: {
    borderRadius: 999,
    height: 180,
    position: "absolute",
    width: 180,
  },
  posterGlowOne: {
    backgroundColor: "rgba(171, 102, 143, 0.92)",
    right: -30,
    top: -10,
  },
  posterGlowTwo: {
    backgroundColor: "rgba(239, 190, 158, 0.78)",
    left: -30,
    bottom: -10,
  },
  posterBadge: {
    color: "#f7e5d4",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  posterTitle: {
    color: "#fffdfb",
    fontSize: 30,
    fontWeight: "800",
    marginTop: 18,
    maxWidth: 220,
  },
  posterMeta: {
    color: "#f6d9c8",
    fontSize: 12,
    marginTop: 8,
  },
  posterAccent: {
    color: "#fff8f2",
    fontSize: 13,
    marginTop: 20,
  },
  playerCard: {
    backgroundColor: "#352a42",
    borderRadius: 24,
    marginTop: 28,
    padding: 18,
  },
  playerHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  playerTag: {
    color: "#d7c2ae",
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: "uppercase",
  },
  playerTitle: {
    color: "#fff7ef",
    fontSize: 22,
    fontWeight: "700",
    marginTop: 4,
  },
  playButton: {
    backgroundColor: "#f2c3d6",
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  playButtonText: {
    color: "#2a1c18",
    fontSize: 15,
    fontWeight: "700",
  },
  transportRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 16,
  },
  transportButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    width: 48,
  },
  transportButtonText: {
    color: "#f8efe9",
    fontSize: 16,
    fontWeight: "700",
  },
  timelineLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  timelineText: {
    color: "#d7c2ae",
    fontSize: 11,
  },
  playbackMessage: {
    color: "#ffd1b3",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
  },
  speedRow: {
    marginTop: 24,
  },
  controlLabel: {
    color: "#ead7c6",
    fontSize: 12,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  chipGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  speedChip: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  speedChipActive: {
    backgroundColor: "#efbad1",
  },
  speedChipText: {
    color: "#f8efe9",
    fontWeight: "600",
  },
  speedChipTextActive: {
    color: "#2a1c18",
  },
  toggleRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 18,
  },
  toggleButton: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 999,
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toggleButtonActive: {
    backgroundColor: "#78516f",
  },
  toggleText: {
    color: "#f7efe8",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  waveform: {
    alignItems: "flex-end",
    flexDirection: "row",
    height: 56,
    justifyContent: "space-between",
    marginTop: 24,
  },
  waveBar: {
    backgroundColor: "#7f625a",
    borderRadius: 999,
    flex: 1,
    marginHorizontal: 2,
    minHeight: 16,
  },
  waveBarActive: {
    backgroundColor: "#efbad1",
  },
  progressTrack: {
    backgroundColor: "#5b403b",
    borderRadius: 999,
    height: 6,
    marginTop: 18,
    overflow: "hidden",
  },
  progressFill: {
    backgroundColor: "#efbad1",
    borderRadius: 999,
    height: "100%",
  },
  nowPlayingWrap: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 14,
    marginTop: 18,
    padding: 14,
  },
  nowPlayingLabel: {
    color: "#d7c2ae",
    fontSize: 12,
    textTransform: "uppercase",
  },
  nowPlayingSpeaker: {
    color: "#fdfaf6",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 8,
  },
  nowPlayingText: {
    color: "#f3e3d5",
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
  },
  timestamp: {
    color: "#d7c2ae",
    fontSize: 12,
    marginTop: 10,
  },
  lyricsSection: {
    marginTop: 20,
  },
  lyricsHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  lyricsTitle: {
    color: "#fdfaf6",
    fontSize: 15,
    fontWeight: "700",
  },
  lyricsHint: {
    color: "#d7c2ae",
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 12,
    marginTop: 5,
  },
  lyricsScroll: {
    maxHeight: 420,
  },
  lyricRow: {
    borderLeftColor: "#644b43",
    borderLeftWidth: 3,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  lyricRowActive: {
    backgroundColor: "rgba(239,186,209,0.12)",
    borderLeftColor: "#efbad1",
    borderLeftWidth: 4,
    borderRadius: 8,
  },
  lyricMeta: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 7,
  },
  lyricSpeaker: {
    color: "#f5b286",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  lyricText: {
    color: "#d9ccc2",
    fontSize: 18,
    lineHeight: 29,
  },
  lyricTime: {
    color: "#d7c2ae",
    fontSize: 11,
  },
  lyricWord: {
    color: "#d9ccc2",
  },
  lyricWordActive: {
    backgroundColor: "#f6c7a4",
    color: "#2a1c18",
    fontWeight: "800",
  },
  readerScreen: {
    backgroundColor: "#fff9f7",
    flex: 1,
    paddingBottom: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  readerToolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 16,
  },
  readerTitle: {
    color: "#44334c",
    flex: 1,
    fontSize: 20,
    fontWeight: "700",
  },
  readerToolbarActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  readerActionButton: {
    alignItems: "center",
    backgroundColor: "#eadce7",
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 40,
    minWidth: 42,
    paddingHorizontal: 12,
  },
  readerActionText: {
    color: "#68405f",
    fontSize: 14,
    fontWeight: "700",
  },
  readerScrollContent: {
    alignSelf: "center",
    maxWidth: 720,
    paddingBottom: 32,
    width: "100%",
  },
  readerText: {
    color: "#44334c",
    fontSize: 22,
    lineHeight: 36,
  },
  fullScreenLyricsHeading: {
    flex: 1,
  },
  fullScreenLyricsBook: {
    color: "#67566a",
    fontSize: 12,
    marginTop: 3,
  },
  fullScreenLyricsContent: {
    alignSelf: "center",
    maxWidth: 720,
    paddingBottom: 24,
    width: "100%",
  },
  fullScreenLyricText: {
    color: "#44334c",
    fontSize: 22,
    lineHeight: 36,
  },
  fullScreenTransport: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: 12,
  },
  note: {
    backgroundColor: "#f0e9df",
    borderRadius: 12,
    marginTop: 32,
    padding: 18,
  },
  noteTitle: {
    color: "#3d342d",
    fontSize: 15,
    fontWeight: "700",
  },
  noteText: {
    color: "#655e56",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
  },
});
