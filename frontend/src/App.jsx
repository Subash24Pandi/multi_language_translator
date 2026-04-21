import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import SessionSetup from './pages/SessionSetup';
import Session from './pages/Session';

function App() {
  return (
    <Router>
      <div className="min-h-screen text-white font-sans flex flex-col items-center justify-center p-4">
        <Routes>
          <Route path="/" element={<SessionSetup />} />
          <Route path="/session/:id" element={<Session />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
