import type { AppProps } from "next/app";
import "../styles.css";

export default function ServiceBApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
