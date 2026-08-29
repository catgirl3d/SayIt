import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import WelcomeGuide from './components/WelcomeGuide'
import Home from './pages/Home'
import History from './pages/History'
import Dictionary from './pages/Dictionary'
import VoiceEnginePage from './features/settings/VoiceEnginePage'
import AIServicePage from './features/settings/AIServicePage'
import AIInstructionsPage from './features/settings/AIInstructionsPage'
import AudioSettingsPage from './features/settings/AudioSettingsPage'
import ShortcutsSettingsPage from './features/settings/ShortcutsSettingsPage'
import GeneralSettingsPage from './features/settings/GeneralSettingsPage'
import AppearancePage from './features/settings/AppearancePage'
import PersonalizationPage from './features/settings/PersonalizationPage'
import DiagnosticsPage from './features/settings/DiagnosticsPage'
import About from './pages/About'
import { initRecorder, cleanup } from './services/recorder'
import { initTheme } from './stores/theme'
import { initAiEnabled } from './stores/aiEnabled'
import { initActivePreset } from './stores/activePreset'
import { getSetting, setSetting } from './services/store'
import { startUpdateService } from './features/update/autoUpdate'
import UpdateDialog from './features/update/UpdateDialog'
import * as bridge from './services/bridge'

export default function App() {
  const [showWelcome, setShowWelcome] = useState(false)
  // 首次挂载时先不渲染主界面，等 onboarding 检查完成再决定，避免"闪一下主页再进向导"
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  const navigate = useNavigate()

  // 初始化 + 清理：必须只在挂载/卸载各执行一次。
  useEffect(() => {
    try {
      void initTheme()
      void initAiEnabled()
      void initActivePreset()
      initRecorder()
      void startUpdateService()
    } catch (err) {
      console.error('[App] Init error:', err)
    }

    // 检查是否需要显示欢迎向导（仅首次安装）
    ;(async () => {
      try {
        const onboardedVersion = await getSetting('onboardingVersion', '')
        if (!onboardedVersion) {
          setShowWelcome(true)
        }
      } catch {
        // Fallback gracefully
      } finally {
        setOnboardingChecked(true)
      }
    })()

    return () => {
      cleanup()
    }
  }, [])

  // 自动更新安装完成后，看门人进程会带 --open-about 重新拉起本程序
  useEffect(() => {
    const unlistenOpenAbout = listen('open-about', () => {
      navigate('/about')
    })
    return () => {
      void unlistenOpenAbout.then((fn) => fn())
    }
  }, [navigate])

  const handleWelcomeComplete = () => {
    setShowWelcome(false)
    void setSetting('onboardingVersion', __APP_VERSION__)
    // 向导完成后通知 Rust 端重新加载快捷键配置
    bridge.notifyShortcutsChanged()
  }

  if (!onboardingChecked) {
    return <div className="h-screen bg-background" />
  }

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="custom-scrollbar flex-1 overflow-y-auto bg-background p-8">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/history" element={<History />} />
            <Route path="/favorites" element={<Navigate to="/history" replace />} />
            <Route path="/hotwords" element={<Dictionary />} />
            <Route path="/dictionary" element={<Navigate to="/hotwords" replace />} />
            <Route path="/voice-engine" element={<VoiceEnginePage />} />
            <Route path="/ai-instructions" element={<AIInstructionsPage />} />
            <Route path="/ai-service" element={<AIServicePage />} />
            <Route path="/audio" element={<AudioSettingsPage />} />
            <Route path="/shortcuts" element={<ShortcutsSettingsPage />} />
            <Route path="/general" element={<GeneralSettingsPage />} />
            <Route path="/settings" element={<Navigate to="/general" replace />} />
            <Route path="/appearance" element={<AppearancePage />} />
            <Route path="/usage" element={<PersonalizationPage />} />
            <Route path="/personalization" element={<Navigate to="/usage" replace />} />
            <Route path="/diagnostics" element={<DiagnosticsPage />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
      </div>
      {showWelcome && <WelcomeGuide onComplete={handleWelcomeComplete} />}
      <UpdateDialog />
    </div>
  )
}
