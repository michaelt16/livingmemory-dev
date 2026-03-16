'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export interface VoiceCloneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (voiceId: string, voiceName: string) => void;
  userName?: string;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VoiceCloneModal({ isOpen, onClose, onSuccess, userName = 'You' }: VoiceCloneModalProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlobs, setAudioBlobs] = useState<{ blob: Blob; name: string; duration: number }[]>([]);
  const [isCloning, setIsCloning] = useState(false);
  const [cloneStatus, setCloneStatus] = useState<'idle' | 'recording' | 'ready' | 'cloning' | 'success' | 'error'>('idle');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordingTimeRef = useRef(0);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      recordingTimeRef.current = 0;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const duration = recordingTimeRef.current;
        setAudioBlobs(prev => [...prev, { blob, name: `Recording ${prev.length + 1}`, duration }]);
        setCloneStatus('ready');
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorder.start(250);
      setIsRecording(true);
      setCloneStatus('recording');
      setRecordingTime(0);
      timerRef.current = setInterval(() => {
        recordingTimeRef.current += 1;
        setRecordingTime(t => t + 1);
      }, 1000);
    } catch {
      setCloneError('Microphone access denied.');
      setCloneStatus('error');
    }
  }, [recordingTime]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      setAudioBlobs(prev => [...prev, { blob: file, name: file.name, duration: 0 }]);
    });
    setCloneStatus('ready');
    e.target.value = '';
  }, []);

  const removeSample = useCallback((index: number) => {
    setAudioBlobs(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) setCloneStatus('idle');
      return next;
    });
  }, []);

  const cloneVoice = useCallback(async () => {
    if (audioBlobs.length === 0) return;
    setIsCloning(true);
    setCloneStatus('cloning');
    setCloneError(null);
    try {
      const formData = new FormData();
      formData.append('voiceName', voiceName || `${userName}'s Voice`);
      formData.append('description', 'Voice clone for Living Memory');
      formData.append('userId', 'default');
      audioBlobs.forEach(({ blob }) => formData.append('files', blob));
      const res = await fetch('/api/voice/clone', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success && data.voiceProfile) {
        setCloneStatus('success');
        setAudioBlobs([]);
        localStorage.setItem('clonedVoiceId', data.voiceProfile.id);
        localStorage.setItem('clonedVoiceName', data.voiceProfile.name);
        onSuccess(data.voiceProfile.id, data.voiceProfile.name);
      } else {
        throw new Error(data.details || data.error || 'Clone failed');
      }
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : 'Clone failed');
      setCloneStatus('error');
    } finally {
      setIsCloning(false);
    }
  }, [audioBlobs, voiceName, userName, onSuccess]);

  useEffect(() => {
    if (!isOpen) return;
    setCloneStatus('idle');
    setCloneError(null);
    setAudioBlobs([]);
    setVoiceName('');
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-md rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <h3 className="text-lg font-medium text-white">Clone your voice</h3>
          <button onClick={onClose} className="p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <p className="text-sm text-white/60">Record or upload 30+ seconds of clear speech. Your voice will be used for album narration.</p>

          {audioBlobs.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-2">Samples ({audioBlobs.length})</p>
              <div className="space-y-2">
                {audioBlobs.map((s, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg px-3 py-2 bg-white/5">
                    <span className="text-sm text-white/80 truncate">{s.name}</span>
                    <div className="flex items-center gap-2">
                      {s.duration > 0 && <span className="text-xs text-white/40">{formatTime(s.duration)}</span>}
                      <button type="button" onClick={() => removeSample(i)} className="text-white/40 hover:text-red-400 text-xs px-1">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isRecording && (
            <div className="flex items-center gap-4 p-4 rounded-xl bg-red-500/10 border border-red-500/30">
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm text-white/90">Recording… {formatTime(recordingTime)}</span>
              <button onClick={stopRecording} className="ml-auto px-3 py-1.5 rounded-lg text-sm font-medium bg-red-500/80 text-white">Stop</button>
            </div>
          )}

          {cloneStatus === 'success' && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-green-500/10 border border-green-500/30">
              <span className="text-green-400">✓</span>
              <p className="text-sm text-white/90">Voice cloned. It’s now available in the narrator list.</p>
            </div>
          )}

          {cloneError && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30">
              <p className="text-sm text-white/80">{cloneError}</p>
            </div>
          )}

          {audioBlobs.length > 0 && !isRecording && cloneStatus !== 'success' && (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-white/40 block mb-1.5">Voice name</label>
              <input
                type="text"
                value={voiceName}
                onChange={e => setVoiceName(e.target.value)}
                placeholder={`${userName}'s Voice`}
                className="w-full rounded-lg px-3 py-2.5 text-sm bg-white/5 border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!isRecording && cloneStatus !== 'cloning' && cloneStatus !== 'success' && (
              <>
                <button
                  type="button"
                  onClick={startRecording}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-all hover:scale-[1.02]"
                  style={{ background: 'linear-gradient(135deg, var(--eva-cyan), var(--eva-teal))' }}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                  </svg>
                  {audioBlobs.length > 0 ? 'Record another' : 'Record'}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white/80 bg-white/10 hover:bg-white/15 border border-white/10 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                  Upload
                </button>
                <input ref={fileInputRef} type="file" accept="audio/*" multiple className="hidden" onChange={handleFileUpload} />
              </>
            )}
            {audioBlobs.length > 0 && !isRecording && cloneStatus !== 'success' && (
              <button
                type="button"
                onClick={cloneVoice}
                disabled={isCloning}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isCloning ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    Cloning…
                  </>
                ) : (
                  'Clone voice'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
