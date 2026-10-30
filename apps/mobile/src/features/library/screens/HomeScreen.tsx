import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { Audio, type AVPlaybackStatus } from "expo-av";
import * as Linking from "expo-linking";
import type { PickedBook, PlaybackCue } from "../types";
import {
  analyzeStory,
  generateAudio,
  importStoryDocument,
  type NarrationStyle,
  saveAnalysisFeedback,
  type GeneratedAudio,
  type StoryAnalysis,
} from "../../../services/api/client";

const playbackSpeeds = [0.75, 1, 1.25, 1.5, 2];
const workspaceTabs = [
  { id: "story", label: "Story", hint: "Import and convert" },
  { id: "cast", label: "Characters", hint: "Review speakers" },
  { id: "sound", label: "Sound", hint: "Shape the mood" },
  { id: "chapters", label: "Chapters", hint: "Plan the book" },
  { id: "player", label: "Listen", hint: "Play the result" },
] as const;
type WorkspaceTab = (typeof workspaceTabs)[number]["id"];

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

function buildStoryCues(storyText: string, chapterCountValue: string): PlaybackCue[] {
  const sentences =
    storyText
      .match(/[^.!?\n]+(?:[.!?]+(?:["”’])?|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
  const rawChapterCount = Number.parseInt(chapterCountValue || "1", 10);
  const requestedCount = Number.isFinite(rawChapterCount)
    ? Math.max(1, Math.min(rawChapterCount, 12))
    : 1;
  const chapterTotal = Math.min(requestedCount, sentences.length);

  return sentences.map((sentence, sentenceIndex) => {
    const chapterNumber = Math.min(
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
  const [chapterCount, setChapterCount] = useState("1");
  const [voiceStyle, setVoiceStyle] = useState<NarrationStyle>("gentle");
  const [book, setBook] = useState<PickedBook | null>(null);
  const [pastedStory, setPastedStory] = useState("");
  const [pastedBookTitle, setPastedBookTitle] = useState("");
  const [activeStoryText, setActiveStoryText] = useState("");
  const [activeBookTitle, setActiveBookTitle] = useState("");
  const [storyAnalysis, setStoryAnalysis] = useState<StoryAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
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
  const [loopChapter, setLoopChapter] = useState(true);
  const audioRef = useRef<Audio.Sound | null>(null);
  const audioTimingsRef = useRef<GeneratedAudio["timings"]>([]);
  const durationRef = useRef(0);
  const lyricScrollRef = useRef<ScrollView>(null);
  const lyricOffsets = useRef<Record<number, number>>({});
  const progressWidth = useRef(0);
  const conversionPulse = useRef(new Animated.Value(0.35)).current;

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
    () =>
      activeStoryText
        ? buildStoryCues(activeStoryText, chapterCount)
        : buildGeneratedCues(bookTitle, chapterCount),
    [activeStoryText, bookTitle, chapterCount],
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
    return () => {
      const sound = audioRef.current;
      if (sound) {
        void sound.unloadAsync().catch((error: unknown) => {
          console.error("Failed to unload audiobook audio.", error);
        });
      }
    };
  }, []);

  useEffect(() => {
    setActiveWordIndex(-1);
    const activeLineOffset = lyricOffsets.current[activeCueIndex];
    if (activeLineOffset !== undefined) {
      lyricScrollRef.current?.scrollTo({
        y: Math.max(0, activeLineOffset - 56),
        animated: true,
      });
    }
  }, [activeCueIndex]);

  function handleAudioStatus(status: AVPlaybackStatus) {
    if (!status.isLoaded) {
      if (status.error) {
        setPlaybackMessage(`Audio playback failed: ${status.error}`);
        setIsPlaying(false);
      }
      return;
    }

    const duration = status.durationMillis ?? 0;
    const position = status.positionMillis;
    durationRef.current = duration;
    setAudioProgress(duration > 0 ? (position / duration) * 100 : 0);
    setIsPlaying(status.isPlaying);

    const timings = audioTimingsRef.current;
    if (duration > 0 && timings.length > 0) {
      const positionSeconds = position / 1000;
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

    if (status.didJustFinish) {
      setIsPlaying(false);
    }
  }

  useEffect(() => {
    const sound = audioRef.current;
    if (!sound) {
      return;
    }

    void sound.setRateAsync(currentSpeed, true).catch((error: unknown) => {
      setPlaybackMessage(
        error instanceof Error ? error.message : "Unable to change playback speed.",
      );
    });
  }, [currentSpeed]);

  useEffect(() => {
    const sound = audioRef.current;
    if (!sound) {
      return;
    }

    void sound.setIsLoopingAsync(loopChapter).catch((error: unknown) => {
      setPlaybackMessage(
        error instanceof Error ? error.message : "Unable to update audio looping.",
      );
    });
  }, [loopChapter]);

  useEffect(() => {
    if (conversionStage !== "rendering") {
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
  }, [conversionPulse, conversionStage]);

  async function clearAudio() {
    const sound = audioRef.current;
    audioRef.current = null;
    if (sound) {
      await sound.unloadAsync();
    }
    setAudioUrl(null);
    setDownloadUrl(null);
    audioTimingsRef.current = [];
    setAudioProgress(0);
    setIsPlaying(false);
    setActiveWordIndex(-1);
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
      setPastedStory("");
      setImportError("");
      setStoryStatus("");
      setIsImporting(true);
      try {
        await clearAudio();
        const title = file.name.replace(
          /\.(?:pdf|odt|docx|html?|md|markdown|txt|text)$/i,
          "",
        );
        const imported = await importStoryDocument(file);
        setPastedStory(imported.text);
        setPastedBookTitle(title);
        setActiveStoryText(imported.text);
        setActiveBookTitle(title);
        setStoryAnalysis(null);
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
    setActiveBookTitle(pastedBookTitle.trim() || "Pasted story");
    setStoryAnalysis(null);
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
      setAnalysisMessage("Analysis ready. Suggestions can be corrected and saved for this book.");
    } catch (error) {
      setAnalysisMessage(
        error instanceof Error ? error.message : "Story analysis failed.",
      );
    } finally {
      setIsAnalyzing(false);
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
      );
      audioTimingsRef.current = result.timings;
      setAudioUrl(result.audioUrl);
      setDownloadUrl(result.downloadUrl);
      setConversionStage("loading");

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
      const { sound } = await Audio.Sound.createAsync(
        { uri: result.audioUrl },
        {
          shouldPlay: false,
          isLooping: loopChapter,
          volume: 1,
          progressUpdateIntervalMillis: 100,
        },
        handleAudioStatus,
      );
      audioRef.current = sound;
      await sound.setRateAsync(currentSpeed, true);
      setStoryStatus(
        `Audiobook ready: ${result.chapters} chapter${result.chapters === 1 ? "" : "s"}. Tap Play to listen.`,
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
    const sound = audioRef.current;
    if (!sound) {
      setPlaybackMessage("Convert the story to audio before pressing play.");
      return;
    }

    try {
      const status = await sound.getStatusAsync();
      if (!status.isLoaded) {
        setPlaybackMessage(status.error ?? "Audio is not ready yet.");
        return;
      }

      if (status.isPlaying) {
        await sound.pauseAsync();
      } else {
        if (status.durationMillis && status.positionMillis >= status.durationMillis) {
          await sound.setPositionAsync(0);
        }
        await sound.playAsync();
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
        await audioRef.current?.setPositionAsync(timing.start * 1000);
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
        await audioRef.current?.setPositionAsync(ratio * durationRef.current);
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
    <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
      <View style={styles.screen}>
        <Text style={styles.eyebrow}>YOUR STORY, PERFORMED</Text>
        <Text style={styles.title}>Your audiobook studio.</Text>
        <Text style={styles.description}>
          Build the story, shape its performance, then listen—all from one place.
        </Text>

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
              <Text style={styles.pastePanelTitle}>Story text</Text>
              <TextInput
                accessibilityLabel="Book title for saved AI preferences"
                onChangeText={(value) => {
                  setPastedBookTitle(value);
                  if (activeStoryText) {
                    setActiveBookTitle(value.trim() || "Pasted story");
                    setStoryAnalysis(null);
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
                    setStoryAnalysis(null);
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
              Character & narrator casting
            </Text>
            <Text style={styles.panelDescription}>
              Review suggested speakers and emotions. Corrections are remembered for this book.
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
                  onPress={() => setChapterCount(String(count))}
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
              onPress={() => setLoopChapter((current) => !current)}
              style={[styles.toggleButton, loopChapter && styles.toggleButtonActive]}
            >
              <Text style={styles.toggleText}>Loop audio</Text>
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
            <Text style={styles.lyricsTitle}>Follow the story</Text>
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
            Corrections are saved in the local API for the same book. The current
            eSpeak converter still uses one narrator voice; soundtrack suggestions
            do not include or play music tracks.
          </Text>
        </View>
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    backgroundColor: "#fbf8f2",
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  screen: {
    alignSelf: "center",
    backgroundColor: "#fbf8f2",
    flex: 1,
    maxWidth: 720,
    padding: 28,
    width: "100%",
  },
  eyebrow: {
    color: "#795548",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginTop: 24,
  },
  title: {
    color: "#28231f",
    fontSize: 36,
    fontWeight: "700",
    marginTop: 10,
  },
  description: {
    color: "#655e56",
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 18,
    marginTop: 12,
  },
  workspaceTabs: {
    backgroundColor: "#eee7df",
    borderRadius: 16,
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
    backgroundColor: "#ffffff",
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
    backgroundColor: "#6d4c41",
    borderRadius: 10,
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
    backgroundColor: "#6d4c41",
    borderColor: "#6d4c41",
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
    backgroundColor: "#3d342d",
    borderRadius: 10,
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
    backgroundColor: "#e5d7ca",
    borderRadius: 10,
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
    backgroundColor: "#ffffff",
    borderColor: "#e3d6c9",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 16,
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
    backgroundColor: "#eee7df",
    borderRadius: 99,
    height: 7,
    marginTop: 14,
    overflow: "hidden",
  },
  conversionFill: {
    backgroundColor: "#9b5b43",
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
  soundCard: {
    backgroundColor: "#2d1e1a",
    borderRadius: 18,
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
    backgroundColor: "#f0e9df",
    borderRadius: 16,
    marginTop: 20,
    padding: 20,
  },
  emptyStateTitle: {
    color: "#3d342d",
    fontSize: 18,
    fontWeight: "700",
  },
  posterCard: {
    backgroundColor: "#261a1d",
    borderRadius: 22,
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
    backgroundColor: "rgba(111, 58, 68, 0.95)",
    right: -30,
    top: -10,
  },
  posterGlowTwo: {
    backgroundColor: "rgba(219, 152, 104, 0.8)",
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
    backgroundColor: "#2d1e1a",
    borderRadius: 20,
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
    backgroundColor: "#f1b790",
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
    backgroundColor: "#f5b286",
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
    backgroundColor: "#6f4838",
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
    backgroundColor: "#f6c7a4",
  },
  progressTrack: {
    backgroundColor: "#5b403b",
    borderRadius: 999,
    height: 6,
    marginTop: 18,
    overflow: "hidden",
  },
  progressFill: {
    backgroundColor: "#f5b286",
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
    backgroundColor: "rgba(246,199,164,0.1)",
    borderLeftColor: "#f6c7a4",
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
