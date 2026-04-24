import { useState, useRef, useCallback } from 'react';

const SILENCE_THRESHOLD = 2;
const SILENCE_DURATION_MS = 800;

export function useAudioRecorder(onAudioComplete) {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const streamRef = useRef(null);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    setIsRecording(false);
    clearTimeout(silenceTimerRef.current);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyserRef.current = analyser;
      analyser.fftSize = 512;
      
      const source = audioContext.createMediaStreamSource(stream);
      // Direct connection - no gain boost to prevent audio distortion
      source.connect(analyser);
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (onAudioComplete) {
            onAudioComplete(audioBlob);
        }
      };
      
      mediaRecorder.start(200);
      setIsRecording(true);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      const checkSilence = () => {
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') return;
        
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        
        if (average < SILENCE_THRESHOLD) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              stopRecording();
            }, SILENCE_DURATION_MS);
          }
        } else {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        }
        
        requestAnimationFrame(checkSilence);
      };
      
      checkSilence();
      
    } catch (err) {
      console.error("Error accessing microphone:", err);
    }
  }, [onAudioComplete, stopRecording]);

  return { isRecording, startRecording, stopRecording };
}
