import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CampaignEditor } from './pages/CampaignEditor';
import { Campaigns } from './pages/Campaigns';
import { Dashboard } from './pages/Dashboard';
import { SequenceEditor } from './pages/SequenceEditor';
import { Sequences } from './pages/Sequences';
import { Brand } from './pages/Brand';
import { Settings } from './pages/Settings';
import { StarterEditor } from './pages/StarterEditor';
import { Subscribers } from './pages/Subscribers';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/:id" element={<CampaignEditor />} />
        <Route path="subscribers" element={<Subscribers />} />
        <Route path="sequences" element={<Sequences />} />
        <Route path="sequences/:id" element={<SequenceEditor />} />
        <Route path="brand" element={<Brand />} />
        <Route path="brand/templates/:id" element={<StarterEditor />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
