import type { AppProps } from "next/app";
import "../styles.css";

export default function ServiceCApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
