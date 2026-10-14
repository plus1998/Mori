import { LoaderCircle, Mic, Send, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAsrAsyncTokenCurrent, nextAsrAsyncToken } from "./asr-async-token";
import { downsampleToMono16k, encodePcm16Wav, MAX_ASR_SECONDS, wavToBase64 } from "./asr-audio";
import { audioConstraintsForInputDevice, isAsrInputDeviceAvailable } from "./asr-input-devices";

interface AsrRecorderCallbacks {
  activeProfileId?: string;
  selectedInputDeviceId: string;
  disabled?: boolean;
  onText: (text: string) => void;
  onSendText: (text: string) => void;
  onError: (message: string) => void;
}

export interface AsrRecorderSession {
  active: boolean;
  recording: boolean;
  busy: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  start: () => Promise<void>;
  stop: (send?: boolean) => void;
  cancel: () => void;
}

export function shouldAnimateWaveform(recording: boolean, busy: boolean, reducedMotion: boolean): boolean {
  return recording && !busy && !reducedMotion;
}

/**
 * Map analyser RMS into 0–1 bar height for monitoring.
 * Soft linear scale so quiet/normal/loud stay visually distinct.
 */
export function mapAsrAnalyserRmsToLevel(rawRms: number): number {
  if (!Number.isFinite(rawRms) || rawRms <= 0) return 0;
  return Math.min(1, rawRms * 8);
}

export function resolveAsrErrorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

export function reportAsrError(onError: (message: string) => void, caught: unknown, fallback: string): void {
  onError(resolveAsrErrorMessage(caught, fallback));
}

export function resolveAsrMediaRecorderError(caught: unknown, fallback: string): string {
  if (caught && typeof caught === "object" && "error" in caught) {
    return resolveAsrErrorMessage((caught as { error?: unknown }).error, fallback);
  }
  return resolveAsrErrorMessage(caught, fallback);
}

export function createAsrCleanupOnce(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}

export function isAsrInputDeviceConstraintError(caught: unknown): boolean {
  return (
    caught instanceof DOMException &&
    (caught.name === "NotFoundError" || caught.name === "OverconstrainedError")
  );
}

export function useAsrRecorder({
  activeProfileId,
  selectedInputDeviceId,
  disabled,
  onText,
  onSendText,
  onError,
}: AsrRecorderCallbacks): AsrRecorderSession {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const sessionTokenRef = useRef(0);
  const sendAfterTranscriptionRef = useRef(false);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const profileIdRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const audioContextsRef = useRef<AudioContext[]>([]);
  const levelHistoryRef = useRef<number[]>(Array.from({ length: 48 }, () => 0));
  const displayLevelRef = useRef(0);
  const targetLevelRef = useRef(0);
  const cancelRef = useRef<() => void>(() => {});
  const drawWaveformRef = useRef<() => void>(() => {});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current();
    };
  }, []);

  useEffect(() => {
    if (!recording || busy) {
      if (animationRef.current !== undefined) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
      return;
    }
    drawWaveformRef.current();
    return () => {
      if (animationRef.current !== undefined) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = undefined;
      }
    };
  }, [recording, busy]);

  async function start() {
    if (disabled || busy || recording || startingRef.current) return;
    startingRef.current = true;
    const sessionToken = nextAsrAsyncToken(sessionTokenRef.current);
    sessionTokenRef.current = sessionToken;
    const capturedProfileId = activeProfileId;
    const capturedInputDeviceId = selectedInputDeviceId;
    const isCurrentSession = () =>
      isAsrAsyncTokenCurrent(sessionToken, sessionTokenRef.current, mountedRef.current);
    let localStream: MediaStream | undefined;
    let localContext: AudioContext | undefined;
    let localRecorder: MediaRecorder | undefined;
    if (!capturedProfileId) {
      reportAsrError(onError, new Error(t("asr.error.noActiveProfile")), t("asr.error.start"));
      startingRef.current = false;
      return;
    }
    try {
      if (capturedInputDeviceId) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!isCurrentSession()) return;
        if (!isAsrInputDeviceAvailable(capturedInputDeviceId, devices)) {
          throw new DOMException(t("asr.error.inputDeviceUnavailable"), "NotFoundError");
        }
      }
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraintsForInputDevice(capturedInputDeviceId),
        video: false,
      });
      if (!isCurrentSession()) {
        abandonLocalStart(localStream);
        return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      localRecorder = mimeType
        ? new MediaRecorder(localStream, { mimeType })
        : new MediaRecorder(localStream);
      streamRef.current = localStream;
      recorderRef.current = localRecorder;
      chunksRef.current = [];
      profileIdRef.current = capturedProfileId;
      sendAfterTranscriptionRef.current = false;
      startedAtRef.current = Date.now();
      levelHistoryRef.current = Array.from({ length: 48 }, () => 0);
      displayLevelRef.current = 0;
      targetLevelRef.current = 0;
      let terminalEventHandled = false;
      const cleanupOnce = createAsrCleanupOnce(() => cleanup());
      localRecorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      localRecorder.onstop = () => {
        if (terminalEventHandled) return;
        terminalEventHandled = true;
        void finish(localRecorder as MediaRecorder, cleanupOnce);
      };
      localRecorder.onerror = (event) => {
        if (terminalEventHandled) return;
        terminalEventHandled = true;
        cleanupOnce();
        if (mountedRef.current) {
          reportAsrError(
            onError,
            resolveAsrMediaRecorderError(event, t("asr.error.start")),
            t("asr.error.start"),
          );
          setRecording(false);
          setBusy(false);
        }
      };
      localContext = new AudioContext();
      if (localContext.state === "suspended") {
        await localContext.resume();
      }
      if (!isCurrentSession()) {
        abandonLocalStart(localStream, localContext, localRecorder);
        return;
      }
      audioContextsRef.current.push(localContext);
      const source = localContext.createMediaStreamSource(localStream);
      const analyser = localContext.createAnalyser();
      source.connect(analyser);
      analyserRef.current = analyser;
      localRecorder.start(250);
      setRecording(true);
      timerRef.current = window.setTimeout(() => stop(false), MAX_ASR_SECONDS * 1000);
    } catch (caught) {
      if (isCurrentSession()) {
        cleanup();
        reportAsrError(
          onError,
          caught instanceof DOMException && caught.name === "NotAllowedError"
            ? new Error(t("asr.error.permission"))
            : capturedInputDeviceId && isAsrInputDeviceConstraintError(caught)
              ? new Error(t("asr.error.inputDeviceUnavailable"))
              : caught,
          t("asr.error.start"),
        );
      } else {
        abandonLocalStart(localStream, localContext, localRecorder);
      }
    } finally {
      startingRef.current = false;
    }
  }

  function stop(send = false) {
    const recorder = recorderRef.current;
    if (recorder?.state !== "recording") return;
    sendAfterTranscriptionRef.current = send;
    recorder.stop();
    if (mountedRef.current) {
      setRecording(false);
      setBusy(true);
    }
  }

  function cancel() {
    sendAfterTranscriptionRef.current = false;
    const recorder = recorderRef.current;
    if (recorder) recorder.onstop = null;
    if (recorder?.state === "recording") recorder.stop();
    cleanup();
    if (mountedRef.current) {
      setRecording(false);
      setBusy(false);
    }
  }

  async function finish(recorder: MediaRecorder, cleanupOnce: () => void) {
    const chunks = chunksRef.current.slice();
    const send = sendAfterTranscriptionRef.current;
    releaseCaptureResources();
    try {
      if (!chunks.length || chunks.every((chunk) => chunk.size === 0)) throw new Error(t("asr.error.empty"));
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/wav" });
      const context = new AudioContext();
      audioContextsRef.current.push(context);
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (!decoded.length || !decoded.numberOfChannels) throw new Error(t("asr.error.empty"));
      const wav = encodePcm16Wav(downsampleToMono16k(decoded));
      const profileId = profileIdRef.current;
      if (!profileId) throw new Error(t("asr.error.noActiveProfile"));
      const result = await window.eco?.transcribeAsr({
        audioWavBase64: wavToBase64(wav),
        profileId,
      });
      if (!result?.text) throw new Error(t("asr.error.emptyResult"));
      if (mountedRef.current) {
        if (send) onSendText(result.text);
        else onText(result.text);
      }
    } catch (caught) {
      if (mountedRef.current) reportAsrError(onError, caught, t("asr.error.transcribe"));
    } finally {
      cleanupOnce();
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }

  function drawWaveform() {
    const analyser = analyserRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!analyser || !canvas || !context) return;
    const timeDomain = new Uint8Array(analyser.fftSize);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lastSampleAt = 0;
    const sampleIntervalMs = 75;
    const maxHistoryLength = 96;

    const draw = (now: number) => {
      analyser.getByteTimeDomainData(timeDomain);
      let sum = 0;
      for (const value of timeDomain) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      const rawRms = Math.sqrt(sum / timeDomain.length);
      targetLevelRef.current = mapAsrAnalyserRmsToLevel(rawRms);

      if (now - lastSampleAt >= sampleIntervalMs) {
        displayLevelRef.current = targetLevelRef.current;
        levelHistoryRef.current.push(displayLevelRef.current);
        if (levelHistoryRef.current.length > maxHistoryLength) {
          levelHistoryRef.current.splice(0, levelHistoryRef.current.length - maxHistoryLength);
        }
        lastSampleAt = now;
      }

      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth || canvas.width;
      const cssHeight = canvas.clientHeight || canvas.height;
      if (canvas.width !== Math.floor(cssWidth * dpr) || canvas.height !== Math.floor(cssHeight * dpr)) {
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);

      const spacing = 5.5;
      const count = Math.max(1, Math.ceil(cssWidth / spacing));
      const slotWidth = cssWidth / count;
      const centerY = cssHeight / 2;
      const history = levelHistoryRef.current;
      const visibleHistory =
        history.length > count
          ? history.slice(history.length - count)
          : [...Array.from({ length: count - history.length }, () => 0), ...history];
      const scrollProgress = Math.min(1, (now - lastSampleAt) / sampleIntervalMs);
      const styles = getComputedStyle(canvas);
      const waveColor = styles.getPropertyValue("--asr-wave-active").trim() || "currentColor";

      for (let index = 0; index <= count; index += 1) {
        const historyLevel = index === count ? displayLevelRef.current : (visibleHistory[index] ?? 0);
        const x = (index + 0.5 - scrollProgress) * slotWidth;
        if (x < -slotWidth || x > cssWidth + slotWidth) continue;
        const normalizedLevel = Math.max(0, Math.min(1, historyLevel));
        const height = 2.5 + (cssHeight - 7) * normalizedLevel;
        context.strokeStyle = waveColor;
        context.globalAlpha = 0.45 + normalizedLevel * 0.55;
        context.lineWidth = 3;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(x, centerY - height / 2);
        context.lineTo(x, centerY + height / 2);
        context.stroke();
      }
      context.globalAlpha = 1;

      if (shouldAnimateWaveform(true, false, reducedMotion) && recorderRef.current?.state === "recording") {
        animationRef.current = requestAnimationFrame(draw);
      }
    };
    animationRef.current = requestAnimationFrame(draw);
  }

  function cleanup() {
    sessionTokenRef.current = nextAsrAsyncToken(sessionTokenRef.current);
    if (recorderRef.current) {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      recorderRef.current.onerror = null;
    }
    releaseCaptureResources();
    recorderRef.current = undefined;
    profileIdRef.current = undefined;
    chunksRef.current = [];
    levelHistoryRef.current = Array.from({ length: 48 }, () => 0);
    displayLevelRef.current = 0;
    targetLevelRef.current = 0;
  }

  function releaseCaptureResources() {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    if (animationRef.current !== undefined) cancelAnimationFrame(animationRef.current);
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    for (const context of audioContextsRef.current) void context.close().catch(() => {});
    timerRef.current = undefined;
    animationRef.current = undefined;
    streamRef.current = undefined;
    analyserRef.current = undefined;
    audioContextsRef.current = [];
  }

  function releaseLocalResources(stream?: MediaStream, context?: AudioContext, recorder?: MediaRecorder) {
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state === "recording") recorder.stop();
    }
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    if (context) void context.close().catch(() => {});
  }

  function abandonLocalStart(stream?: MediaStream, context?: AudioContext, recorder?: MediaRecorder) {
    releaseLocalResources(stream, context, recorder);
    if (stream && streamRef.current === stream) streamRef.current = undefined;
    if (recorder && recorderRef.current === recorder) recorderRef.current = undefined;
    if (context) {
      audioContextsRef.current = audioContextsRef.current.filter((entry) => entry !== context);
    }
  }

  cancelRef.current = cancel;
  drawWaveformRef.current = drawWaveform;

  return {
    active: recording || busy,
    recording,
    busy,
    canvasRef,
    start,
    stop,
    cancel,
  };
}

export interface AsrComposerReadinessInput {
  profiles: readonly { id: string; model: string; hasApiKey: boolean }[];
  activeProfileId: string;
  inputDeviceId?: string;
}

/**
 * Composer 默认不展示语音输入按钮：
 * 只有启用中的配置真正可用（填了模型且已保存 API key，否则转写必定失败）、
 * 并且在设置里选过输入设备时，才把按钮显示出来。
 */
export function isAsrComposerConfigured(input: AsrComposerReadinessInput): boolean {
  if (!input.inputDeviceId) return false;
  const activeProfile = input.profiles.find((profile) => profile.id === input.activeProfileId);
  return Boolean(activeProfile?.model.trim() && activeProfile.hasApiKey);
}

export function AsrMicButton({ session, disabled }: { session: AsrRecorderSession; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="asr-recorder">
      <button
        type="button"
        title={t("asr.record")}
        aria-label={t("asr.record")}
        onClick={() => void session.start()}
        disabled={disabled || session.busy || session.recording}
      >
        <Mic size={15} />
      </button>
    </div>
  );
}

export function AsrVoiceComposer({ session }: { session: AsrRecorderSession }) {
  const { t } = useTranslation();
  const finishing = session.busy;

  return (
    <div className={`asr-voice-composer${finishing ? " is-busy" : ""}`} aria-busy={finishing}>
      <button
        type="button"
        className="asr-voice-round-button"
        title={t("asr.cancel")}
        aria-label={t("asr.cancel")}
        onClick={session.cancel}
        disabled={finishing}
      >
        <X size={20} strokeWidth={2.2} />
      </button>
      <div className="asr-voice-pill">
        <canvas ref={session.canvasRef} className="asr-voice-wave" aria-label={t("asr.level")} />
        <button
          type="button"
          className="asr-voice-round-button"
          title={t("asr.stopInsert")}
          aria-label={t("asr.stopInsert")}
          onClick={() => session.stop(false)}
          disabled={finishing}
        >
          {finishing ? (
            <LoaderCircle size={18} className="asr-voice-spinner" aria-hidden />
          ) : (
            <span className="asr-voice-stop-icon" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="asr-voice-round-button is-send"
          title={t("asr.stopSend")}
          aria-label={t("asr.stopSend")}
          onClick={() => session.stop(true)}
          disabled={finishing}
        >
          <Send size={18} strokeWidth={2.1} />
        </button>
      </div>
    </div>
  );
}

/** @deprecated Prefer useAsrRecorder + AsrMicButton / AsrVoiceComposer */
export function AsrRecorder(props: AsrRecorderCallbacks) {
  const session = useAsrRecorder(props);
  if (session.active) {
    return <AsrVoiceComposer session={session} />;
  }
  return (
    <AsrMicButton session={session} {...(props.disabled !== undefined ? { disabled: props.disabled } : {})} />
  );
}
