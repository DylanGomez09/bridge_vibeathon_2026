import { useBridgeSessions } from "./useBridgeSessions.js"

export function useBridgeSession() {
  const controller = useBridgeSessions()
  const { focused } = controller

  return {
    phase: focused.phase,
    connState: focused.connState,
    error: focused.error,
    segments: focused.segments,
    currentOriginal: focused.currentOriginal,
    currentTranslation: focused.currentTranslation,
    sourceInfo: focused.sourceInfo,
    processingFile: focused.processingFile,
    progress: focused.progress,
    sessions: controller.sessions,
    sessionId: focused.sessionId,
    isOwner: focused.isOwner,
    maxSessions: controller.maxSessions,
    runtimes: controller.runtimes,
    focusId: controller.focusId,
    focus: controller.focus,
    createSession: controller.createSession,
    closeSession: controller.closeSession,
    startMicFor: controller.startMic,
    playFileFor: controller.playFile,
    stopFor: controller.stop,
    startMic: focused.startMic,
    playFile: focused.playFile,
    stop: focused.stop,
    tuneTo: focused.tuneTo,
    leaveSession: focused.leaveSession,
    refreshSessions: controller.refreshSessions,
  }
}
