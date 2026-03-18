import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import PlatformLayout from './layouts/PlatformLayout'
import AgentPage from './pages/AgentPage'
import InventoryPage from './pages/InventoryPage'
import ConfigPage from './pages/ConfigPage'
import ArchitecturePage from './pages/ArchitecturePage'
import ConceptsPage from './pages/ConceptsPage'
import MembersPage from './pages/MembersPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<PlatformLayout />}>
          <Route index element={<Navigate to="/agent" replace />} />
          <Route path="agent" element={<AgentPage />} />
          <Route path="inventory" element={<InventoryPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="architecture" element={<ArchitecturePage />} />
          <Route path="concepts" element={<ConceptsPage />} />
          <Route path="members" element={<MembersPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
