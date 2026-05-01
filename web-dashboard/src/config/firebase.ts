import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, RecaptchaVerifier } from 'firebase/auth';

// Your web app's Firebase configuration
// Make sure to add these to your web-dashboard/.env file
const firebaseConfig = {
  apiKey: "AIzaSyDaFCAx9QgW67Y9OHC_TsISdv0PevA1jJc",
  authDomain: "carpool-3e72b.firebaseapp.com",
  projectId: "carpool-3e72b",
  storageBucket: "carpool-3e72b.firebasestorage.app",
  messagingSenderId: "736409496343",
  appId: "1:736409496343:web:b2c257eefb6672df86e552",
  measurementId: "G-Y956Y99MB1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication and get a reference to the service
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Initialize recaptcha verifier for phone auth
export const setupRecaptcha = (buttonId: string) => {
  if (!(window as any).recaptchaVerifier) {
    (window as any).recaptchaVerifier = new RecaptchaVerifier(auth, buttonId, {
      size: 'invisible',
      callback: (response: any) => {
        // reCAPTCHA solved, allow signInWithPhoneNumber.
      }
    });
  }
  return (window as any).recaptchaVerifier;
};
