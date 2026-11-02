export const metadata = {
  title: "Expenses",
  description: "Private expense tracker",
  manifest: "/manifest.webmanifest",
};

export const viewport = {
  themeColor: "#111827",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f9fafb", color: "#111827" }}>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}

function ServiceWorkerRegister() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js'); }`,
      }}
    />
  );
}
