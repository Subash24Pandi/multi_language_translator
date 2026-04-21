import { create } from 'zustand';

export const useStore = create((set) => ({
  sessionId: '',
  role: 'doctor', // 'doctor' or 'patient'
  language: 'en',
  partnerJoined: false,
  partnerLanguage: '',
  partnerRole: '',
  setSessionData: (data) => set((state) => ({ ...state, ...data })),
  resetSession: () => set({ sessionId: '', partnerJoined: false, partnerLanguage: '', partnerRole: '' })
}));
