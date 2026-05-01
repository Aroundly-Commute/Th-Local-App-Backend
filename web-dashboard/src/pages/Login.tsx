import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPopup, signInWithPhoneNumber, ConfirmationResult } from 'firebase/auth';
import { auth, googleProvider, setupRecaptcha } from '../config/firebase';

export default function Login() {
  const navigate = useNavigate();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    try {
      setLoading(true);
      setError('');
      await signInWithPopup(auth, googleProvider);
      navigate('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError('');
      const recaptchaVerifier = setupRecaptcha('sign-in-button');
      const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+91${phoneNumber}`; // default to +91 if needed, or ask user to provide format
      const confirmation = await signInWithPhoneNumber(auth, formattedPhone, recaptchaVerifier);
      setConfirmationResult(confirmation);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmationResult) return;
    try {
      setLoading(true);
      setError('');
      await confirmationResult.confirm(otp);
      navigate('/');
    } catch (err: any) {
      setError('Invalid OTP. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-slate-900 rounded-2xl shadow-xl p-8 border border-slate-800">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-2">Welcome to CarPool</h2>
          <p className="text-slate-400">Sign in to start riding or driving</p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-500 p-3 rounded-lg mb-6 text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 py-3 px-4 rounded-xl font-semibold hover:bg-slate-100 transition-colors mb-6"
        >
          <img src="https://www.svgrepo.com/show/475656/google-color.svg" className="w-5 h-5" alt="Google" />
          Continue with Google
        </button>

        <div className="relative flex items-center py-5">
          <div className="flex-grow border-t border-slate-700"></div>
          <span className="flex-shrink-0 mx-4 text-slate-500 text-sm">or</span>
          <div className="flex-grow border-t border-slate-700"></div>
        </div>

        {!confirmationResult ? (
          <form onSubmit={handleSendOtp} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Phone Number (with country code)</label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+91 9999999999"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                required
              />
            </div>
            <button
              id="sign-in-button"
              type="submit"
              disabled={loading || !phoneNumber}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send OTP
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Enter OTP</label>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="123456"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading || !otp}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Verify OTP
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
