'use client';

import { useRef } from 'react';

interface ControlsBarProps {
  cameraActive: boolean;
  videoReady: boolean;
  onCameraToggle: () => void;
  isScanning: boolean;
  isExtracting: boolean;
  onScanToggle: () => void;
  isConnected: boolean;
  isMicActive: boolean;
  onMicToggle: () => void;
  isFinishing: boolean;
  photoCount: number;
  onFinishSession: () => void;
  hideFinishButton?: boolean;
  onUploadPhotos?: (files: FileList) => void;
  onUseSamples?: () => void;
}

/** Slash overlay to indicate "off" state */
function SlashOverlay({ className = '' }: { className?: string }) {
  return (
    <span
      className={`absolute inset-0 flex items-center justify-center pointer-events-none ${className}`}
      aria-hidden
    >
      <span className="w-[140%] h-0.5 bg-current rotate-45 opacity-70" />
    </span>
  );
}

export function ControlsBar({
  cameraActive,
  videoReady,
  onCameraToggle,
  isScanning,
  isExtracting,
  onScanToggle,
  isConnected,
  isMicActive,
  onMicToggle,
  isFinishing,
  photoCount,
  onFinishSession,
  hideFinishButton = false,
  onUploadPhotos,
  onUseSamples,
}: ControlsBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scanDisabled = !cameraActive || !videoReady || isExtracting;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 p-6">
      <div className="flex items-center justify-center gap-3 sm:gap-4 flex-wrap">
        {onUploadPhotos && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  onUploadPhotos(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!isConnected}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
                !isConnected
                  ? 'bg-white/5 text-white/30 cursor-not-allowed'
                  : 'bg-purple-500/20 border border-purple-400/40 text-purple-400 hover:bg-purple-500/30'
              }`}
              title="Upload photos from device"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </button>
          </>
        )}

        {onUseSamples && (
          <button
            onClick={onUseSamples}
            disabled={!isConnected}
            className={`h-14 px-4 rounded-full flex items-center justify-center gap-2 transition-all ${
              !isConnected
                ? 'bg-white/5 text-white/30 cursor-not-allowed'
                : 'bg-amber-500/20 border border-amber-400/40 text-amber-400 hover:bg-amber-500/30'
            }`}
            title="Load sample family photos"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M6.75 7.5h.008v.008H6.75V7.5z" />
            </svg>
            <span className="text-sm font-medium">Samples</span>
          </button>
        )}

        {/* Camera: slash when off, blue when on */}
        <button
          onClick={onCameraToggle}
          disabled={!isConnected}
          title={cameraActive ? 'Camera on (tap to turn off)' : 'Camera off (tap to turn on)'}
          className={`relative w-14 h-14 rounded-full flex items-center justify-center transition-all ${
            !isConnected
              ? 'bg-white/5 text-white/30 cursor-not-allowed'
              : cameraActive
                ? 'bg-blue-500/40 border-2 border-blue-400 text-blue-300'
                : 'bg-white/10 border border-white/25 text-white/40 hover:text-white/60 hover:border-white/35'
          }`}
        >
          <svg className="w-6 h-6 relative z-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
          </svg>
          {isConnected && !cameraActive && <SlashOverlay className="text-red-400/90" />}
        </button>

        {/* Scanner: slash when off or disabled, green when scanning */}
        <button
          onClick={onScanToggle}
          disabled={scanDisabled}
          title={isScanning ? 'Scanning (tap to stop)' : scanDisabled ? 'Turn camera on to scan' : 'Scan photo'}
          className={`relative w-14 h-14 rounded-full flex items-center justify-center transition-all ${
            scanDisabled
              ? 'bg-white/5 text-white/30 cursor-not-allowed'
              : isScanning
                ? 'bg-green-500/40 border-2 border-green-400 text-green-300 shadow-lg shadow-green-400/25'
                : 'bg-white/10 border border-white/25 text-white/40 hover:text-white/60 hover:border-white/35'
          }`}
        >
          {isScanning && (
            <span className="absolute inset-0 rounded-full border-2 border-green-400 animate-ping opacity-25" />
          )}
          <svg className="w-6 h-6 relative z-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.5h3.75v3.75H3.75V4.5zM3.75 15.75h3.75v3.75H3.75v-3.75zM15.75 4.5h4.5v3.75h-4.5V4.5z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.25v2.25h2.25M5.25 18.75v-2.25h2.25M18.75 5.25v2.25h-2.25M15.75 15.75h4.5v4.5h-4.5v-4.5z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 18.75v-2.25h-2.25" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v7.5M8.25 12h7.5" />
          </svg>
          {!isScanning && <SlashOverlay className="text-red-400/80" />}
        </button>

        {/* Mic: slash when off, green + "Listening" when on */}
        <button
          onClick={onMicToggle}
          disabled={!isConnected}
          title={isMicActive ? 'Microphone on — listening' : 'Microphone off — tap to talk'}
          className={`relative w-16 h-16 rounded-full flex flex-col items-center justify-center gap-0.5 transition-all ${
            !isConnected
              ? 'bg-white/5 text-white/30 cursor-not-allowed'
              : isMicActive
                ? 'bg-emerald-500 border-2 border-emerald-400 text-white shadow-lg shadow-emerald-400/30'
                : 'bg-white/10 border border-white/25 text-white/50 hover:text-white/70 hover:border-white/40'
          }`}
        >
          {isMicActive && (
            <div className="absolute inset-0 rounded-full border-2 border-emerald-400/60 animate-ping opacity-40" />
          )}
          <svg className="w-7 h-7 relative z-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
          </svg>
          {isConnected && !isMicActive && <SlashOverlay className="text-red-400/90" />}
          <span className={`relative z-0 text-[10px] font-medium uppercase tracking-wider ${isMicActive ? 'text-emerald-100' : 'text-white/50'}`}>
            {isMicActive ? 'On' : 'Off'}
          </span>
        </button>

        {!hideFinishButton && (
          <button
            onClick={onFinishSession}
            disabled={isFinishing || photoCount === 0}
            className={`px-4 h-14 rounded-full flex items-center justify-center gap-2 transition-all ${
              isFinishing || photoCount === 0
                ? 'bg-white/5 text-white/30 cursor-not-allowed'
                : 'bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30'
            }`}
          >
            {isFinishing ? (
              <>
                <span className="w-4 h-4 border-2 border-green-400/30 border-t-green-400 rounded-full animate-spin" />
                <span className="text-sm font-medium">Saving...</span>
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span className="text-sm font-medium">Finish</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
