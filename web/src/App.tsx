import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { getCurrentUser } from '@aws-amplify/auth'
import LoginPage from './pages/LoginPage'
import PlatformLayout from './layouts/PlatformLayout'
import AgentPage from './pages/AgentPage'
import InventoryPage from './pages/InventoryPage'
import ConfigPage from './pages/ConfigPage'
import ArchitecturePage from './pages/ArchitecturePage'
import ConceptsPage from './pages/ConceptsPage'
import MembersPage from './pages/MembersPage'
import TestCasePage from './pages/TestCasePage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    getCurrentUser()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
      .finally(() => setChecked(true))
  }, [])

  if (!checked) return null
  return authed ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RequireAuth><PlatformLayout /></RequireAuth>}>
          <Route index element={<Navigate to="/agent" replace />} />
          <Route path="agent" element={<AgentPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="architecture" element={<ArchitecturePage />} />
          <Route path="concepts" element={<ConceptsPage />} />
          <Route path="members" element={<MembersPage />} />
        </Route>
        <Route path="/test-case/:id" element={<RequireAuth><TestCasePage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
