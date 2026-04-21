import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../utils/store';
import { motion } from 'framer-motion';
import { Stethoscope, User, Globe2 } from 'lucide-react';

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'kn', name: 'Kannada' },
  { code: 'bn', name: 'Bengali' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'mr', name: 'Marathi' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'or', name: 'Odia' }
];

export default function SessionSetup() {
  const navigate = useNavigate();
  const setSessionData = useStore((state) => state.setSessionData);
  
  const [sessionId, setSessionIdInput] = useState('');
  const [role, setRole] = useState('doctor');
  const [language, setLanguage] = useState('en');

  const handleJoin = () => {
    if (!sessionId) return;
    setSessionData({ sessionId, role, language });
    navigate(`/session/${sessionId}`);
  };

  const generateSession = () => {
    const newId = Math.random().toString(36).substring(2, 8).toUpperCase();
    setSessionIdInput(newId);
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-panel p-8 rounded-3xl w-full max-w-md"
    >
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
          Nexus Translator
        </h1>
        <p className="text-gray-400 mt-2">Real-time medical voice translation</p>
      </div>

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">I am a</label>
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => setRole('doctor')}
              className={`flex items-center justify-center p-3 rounded-xl border transition-all ${
                role === 'doctor' 
                ? 'border-primary bg-primary/20 text-white' 
                : 'border-white/10 bg-white/5 text-gray-400 hover:bg-white/10'
              }`}
            >
              <Stethoscope className="w-5 h-5 mr-2" />
              Doctor
            </button>
            <button
              onClick={() => setRole('patient')}
              className={`flex items-center justify-center p-3 rounded-xl border transition-all ${
                role === 'patient' 
                ? 'border-primary bg-primary/20 text-white' 
                : 'border-white/10 bg-white/5 text-gray-400 hover:bg-white/10'
              }`}
            >
              <User className="w-5 h-5 mr-2" />
              Patient
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">My Language</label>
          <div className="relative">
            <Globe2 className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-10 pr-4 text-white appearance-none focus:outline-none focus:border-primary transition-colors"
            >
              {LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code} className="bg-dark">
                  {lang.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Session ID</label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={sessionId}
              onChange={(e) => setSessionIdInput(e.target.value.toUpperCase())}
              placeholder="Enter ID"
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-primary transition-colors uppercase tracking-wider"
            />
            <button
              onClick={generateSession}
              className="bg-white/10 hover:bg-white/20 text-white px-4 py-3 rounded-xl transition-colors text-sm font-medium"
            >
              Generate
            </button>
          </div>
        </div>

        <button
          onClick={handleJoin}
          disabled={!sessionId}
          className="w-full bg-primary hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition-all shadow-lg shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed mt-4"
        >
          Join Session
        </button>
      </div>
    </motion.div>
  );
}
