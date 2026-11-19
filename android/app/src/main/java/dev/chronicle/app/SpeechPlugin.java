package dev.chronicle.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Read replies aloud (Android text-to-speech) and dictate messages (the system speech recognizer screen –
 * the app itself needs no microphone permission). The WebView can do neither on its own.
 */
@CapacitorPlugin(name = "Speech", permissions = { @com.getcapacitor.annotation.Permission(alias = "microphone", strings = { android.Manifest.permission.RECORD_AUDIO }) })
public class SpeechPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final List<Runnable> waiting = new ArrayList<>();
    private int session = 0;
    private String engine = null; // null = the phone's default TTS engine

    /** Run r once a TTS engine is ready; switching engine (e.g. a voice-cloning app) restarts it. */
    private void withTts(String wantEngine, Runnable r) {
        if (tts != null && !Objects.equals(wantEngine, engine)) {
            tts.shutdown();
            tts = null;
            ttsReady = false;
        }
        engine = wantEngine;
        if (ttsReady) {
            r.run();
            return;
        }
        waiting.add(r);
        if (tts != null) return;
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { if (id.endsWith(":last")) notifyDone(id, "done"); }
                    @Override public void onError(String id) { notifyDone(id, "error"); }
                    @Override public void onStop(String id, boolean interrupted) { if (id.endsWith(":last")) notifyDone(id, "stopped"); }
                });
            }
            List<Runnable> run = new ArrayList<>(waiting);
            waiting.clear();
            for (Runnable x : run) x.run();
        }, wantEngine);
    }

    private void notifyDone(String id, String how) {
        JSObject e = new JSObject();
        e.put("id", id.split(":")[0]);
        e.put("how", how);
        notifyListeners("speechDone", e);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        float rate = call.getFloat("rate", 1f);
        float pitch = call.getFloat("pitch", 1f);
        String id = call.getString("id", String.valueOf(++session));
        String voiceName = call.getString("voice");
        withTts(call.getString("engine"), () -> {
            if (!ttsReady) {
                call.reject("Text-to-speech isn't available on this phone");
                return;
            }
            tts.stop();
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            // the character's own voice, or the engine's default (so one character's voice doesn't stick)
            Voice chosen = null;
            Set<Voice> all = tts.getVoices();
            if (voiceName != null && all != null) for (Voice v : all) if (v.getName().equals(voiceName)) chosen = v;
            if (chosen == null) chosen = tts.getDefaultVoice();
            if (chosen != null) tts.setVoice(chosen);
            // long text: split into chunks the engine accepts, queued one after another
            int max = Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 100);
            List<String> parts = new ArrayList<>();
            String rest = text;
            while (rest.length() > max) {
                int cut = rest.lastIndexOf(". ", max);
                if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
                if (cut < max / 2) cut = max;
                parts.add(rest.substring(0, cut + 1));
                rest = rest.substring(cut + 1);
            }
            parts.add(rest);
            for (int i = 0; i < parts.size(); i++) {
                Bundle params = new Bundle();
                String uid = id + ":" + i + (i == parts.size() - 1 ? ":last" : "");
                tts.speak(parts.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, params, uid);
            }
            JSObject r = new JSObject();
            r.put("id", id);
            call.resolve(r);
        });
    }

    /** Installed TTS engines and the voices of one engine (default: the phone's default engine). */
    @PluginMethod
    public void voices(PluginCall call) {
        String want = call.getString("engine");
        withTts(want, () -> {
            JSObject r = new JSObject();
            if (!ttsReady) {
                call.reject("That text-to-speech engine didn't start");
                return;
            }
            JSArray engines = new JSArray();
            for (TextToSpeech.EngineInfo e : tts.getEngines()) {
                JSObject o = new JSObject();
                o.put("name", e.name);
                o.put("label", e.label);
                engines.put(o);
            }
            r.put("engines", engines);
            r.put("defaultEngine", tts.getDefaultEngine());
            r.put("engine", want != null ? want : tts.getDefaultEngine());
            JSArray vs = new JSArray();
            Set<Voice> all = tts.getVoices();
            if (all != null) {
                for (Voice v : all) {
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale() != null ? v.getLocale().toLanguageTag() : "");
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("quality", v.getQuality());
                    vs.put(o);
                }
            }
            r.put("voices", vs);
            call.resolve(r);
        });
    }

    /** Android's "install voice data" screen (more voices for the engine), or the phone's text-to-speech settings. */
    @PluginMethod
    public void installVoices(PluginCall call) {
        try {
            Intent i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
        } catch (Exception e) {
            try {
                Intent i = new Intent("com.android.settings.TTS_SETTINGS");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(i);
            } catch (Exception e2) {
                call.reject("Could not open the voice settings");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @PluginMethod
    public void listen(PluginCall call) {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, call.getString("prompt", "Speak your message"));
        String lang = call.getString("lang");
        if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        try {
            startActivityForResult(call, i, "onSpeechResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No speech recognizer on this phone (install Google app / Speech Services)");
        }
    }

    @ActivityCallback
    private void onSpeechResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        String text = "";
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            ArrayList<String> m = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (m != null && !m.isEmpty()) text = m.get(0);
        }
        r.put("text", text);
        call.resolve(r);
    }

    // ---------- voice mode: listening inside the app (no dialog), with what is heard so far ----------
    private android.speech.SpeechRecognizer live;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    /** Ask for the microphone (only voice mode needs it; dictation uses the system screen). */
    @PluginMethod
    public void micPermission(PluginCall call) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("microphone", call, "onMicPermission");
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void onMicPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED);
        call.resolve(r);
    }

    /** Listen once in the app: events livePartial {text}, liveLevel {rms}, liveResult {text}, liveEnd {error}. */
    @PluginMethod
    public void startLive(PluginCall call) {
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Microphone not allowed");
            return;
        }
        final String lang = call.getString("lang");
        main.post(() -> {
            try {
                if (!android.speech.SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    call.reject("No speech recognizer on this phone (install Google app / Speech Services)");
                    return;
                }
                if (live != null) live.destroy();
                live = android.speech.SpeechRecognizer.createSpeechRecognizer(getContext());
                live.setRecognitionListener(new android.speech.RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle b) { notifyListeners("liveReady", new JSObject()); }
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rms) {
                        JSObject e = new JSObject();
                        e.put("rms", rms);
                        notifyListeners("liveLevel", e);
                    }
                    @Override public void onBufferReceived(byte[] b) {}
                    @Override public void onEndOfSpeech() {}
                    @Override public void onError(int err) {
                        JSObject e = new JSObject();
                        e.put("error", err == android.speech.SpeechRecognizer.ERROR_NO_MATCH || err == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "silence" : "error " + err);
                        notifyListeners("liveEnd", e);
                    }
                    @Override public void onResults(Bundle b) {
                        ArrayList<String> m = b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
                        JSObject e = new JSObject();
                        e.put("text", m != null && !m.isEmpty() ? m.get(0) : "");
                        notifyListeners("liveResult", e);
                    }
                    @Override public void onPartialResults(Bundle b) {
                        ArrayList<String> m = b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
                        if (m == null || m.isEmpty()) return;
                        JSObject e = new JSObject();
                        e.put("text", m.get(0));
                        notifyListeners("livePartial", e);
                    }
                    @Override public void onEvent(int t, Bundle b) {}
                });
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
                if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                live.startListening(i);
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    @PluginMethod
    public void stopLive(PluginCall call) {
        main.post(() -> {
            if (live != null) {
                live.destroy();
                live = null;
            }
        });
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        if (live != null) live.destroy();
    }
}
