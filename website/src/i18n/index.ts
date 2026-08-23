export type Locale = 'en' | 'tr';

export const defaultLocale: Locale = 'en';
export const locales: Locale[] = ['en', 'tr'];

export function getLocaleFromUrl(url: URL): Locale {
  const [, locale] = url.pathname.split('/');
  if (locale === 'tr') return 'tr';
  return 'en';
}

export function getLocalizedPath(path: string, locale: Locale): string {
  if (locale === 'en') return path;
  return `/tr${path}`;
}

export function getAlternateLocalePath(currentPath: string, currentLocale: Locale): string {
  if (currentLocale === 'en') {
    return `/tr${currentPath}`;
  }
  return currentPath.replace(/^\/tr/, '') || '/';
}

export interface NavItem {
  label: string;
  href: string;
  children?: NavItem[];
}

export function getNavigation(locale: Locale): NavItem[] {
  const prefix = locale === 'tr' ? '/tr' : '';
  if (locale === 'tr') {
    return [
      { label: 'Ana Sayfa', href: `${prefix}/` },
      { label: 'Özellikler', href: `${prefix}/features` },
      {
        label: 'Dokümantasyon', href: `${prefix}/docs`, children: [
          { label: 'Kurulum', href: `${prefix}/docs/installation` },
          { label: 'Kullanım', href: `${prefix}/docs/usage` },
          { label: 'CLI Referansı', href: `${prefix}/docs/cli-reference` },
          { label: 'Sağlayıcılar', href: `${prefix}/docs/providers` },
          { label: 'Oturumlar', href: `${prefix}/docs/sessions` },
          { label: 'Filo', href: `${prefix}/docs/fleet` },
          { label: 'MCP', href: `${prefix}/docs/mcp` },
        ]
      },
      { label: 'Mimari', href: `${prefix}/architecture` },
      { label: 'Kullanım Senaryoları', href: `${prefix}/use-cases` },
      { label: 'Fiyatlandırma', href: `${prefix}/pricing` },
      { label: 'SSS', href: `${prefix}/faq` },
    ];
  }
  return [
    { label: 'Home', href: '/' },
    { label: 'Features', href: '/features' },
    {
      label: 'Docs', href: '/docs', children: [
        { label: 'Installation', href: '/docs/installation' },
        { label: 'Usage', href: '/docs/usage' },
        { label: 'CLI Reference', href: '/docs/cli-reference' },
        { label: 'Providers', href: '/docs/providers' },
        { label: 'Sessions', href: '/docs/sessions' },
        { label: 'Fleet', href: '/docs/fleet' },
        { label: 'MCP', href: '/docs/mcp' },
      ]
    },
    { label: 'Architecture', href: '/architecture' },
    { label: 'Use Cases', href: '/use-cases' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'FAQ', href: '/faq' },
  ];
}

export interface Translations {
  site: {
    title: string;
    description: string;
    tagline: string;
  };
  hero: {
    title: string;
    subtitle: string;
    cta: string;
    ctaDocs: string;
  };
  features: {
    title: string;
    subtitle: string;
  };
  docs: {
    title: string;
    subtitle: string;
  };
  pricing: {
    title: string;
    subtitle: string;
    comingSoon: string;
    month: string;
    seat: string;
    custom: string;
    free: string;
  };
  faq: {
    title: string;
    subtitle: string;
  };
  footer: {
    license: string;
    madeBy: string;
    notAffiliated: string;
  };
  nav: {
    darkMode: string;
    lightMode: string;
    language: string;
    menu: string;
  };
}

export const translations: Record<Locale, Translations> = {
  en: {
    site: {
      title: 'keyflip',
      description: 'Multi-account switcher for Claude Code & AI tools. Zero dependencies, cross-platform, 130+ commands.',
      tagline: 'Multi-account switcher for Claude Code & AI tools',
    },
    hero: {
      title: 'Switch Claude accounts in one command',
      subtitle: 'Log in to multiple Anthropic accounts once, then hop between them without repeatedly logging in and out. Zero dependencies, cross-platform, 130+ CLI commands.',
      cta: 'Get Started',
      ctaDocs: 'Read the Docs',
    },
    features: {
      title: 'Features',
      subtitle: 'Everything you need to manage multiple AI accounts on one machine',
    },
    docs: {
      title: 'Documentation',
      subtitle: 'Learn how to install, configure, and master keyflip',
    },
    pricing: {
      title: 'Pricing',
      subtitle: 'Open core, free forever. Paid tiers for scale, teams, and automation.',
    },
    faq: {
      title: 'Frequently Asked Questions',
      subtitle: 'Common questions about keyflip',
    },
    footer: {
      license: 'MIT License',
      madeBy: 'Made by',
      notAffiliated: 'Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.',
    },
    nav: {
      darkMode: 'Dark mode',
      lightMode: 'Light mode',
      language: 'Language',
      menu: 'Menu',
    },
  },
  tr: {
    site: {
      title: 'keyflip',
      description: 'Claude Code ve AI araçları için çoklu hesap değiştirici. Sıfır bağımlılık, çoklu platform, 130+ komut.',
      tagline: 'Claude Code ve AI araçları için çoklu hesap değiştirici',
    },
    hero: {
      title: 'Claude hesaplarını tek komutla değiştir',
      subtitle: 'Birden fazla Anthropic hesabına bir kez giriş yapın, ardından tekrar tekrar giriş/çıkış yapmadan aralarında geçiş yapın. Sıfır bağımlılık, çoklu platform, 130+ CLI komutu.',
      cta: 'Başlayın',
      ctaDocs: 'Dokümantasyon',
    },
    features: {
      title: 'Özellikler',
      subtitle: 'Tek makinede birden fazla AI hesabını yönetmek için ihtiyacınız olan her şey',
    },
    docs: {
      title: 'Dokümantasyon',
      subtitle: "keyflip'i nasıl kuracağınızı, yapılandıracağınızı ve ustaca kullanacağınızı öğrenin",
    },
    pricing: {
      title: 'Fiyatlandırma',
      subtitle: 'Açık çekirdek, sonsuza kadar ücretsiz. Ölçek, takımlar ve otomasyon için ücretli katmanlar.',
    },
    faq: {
      title: 'Sıkça Sorulan Sorular',
      subtitle: 'keyflip hakkında sık sorulan sorular',
    },
    footer: {
      license: 'MIT Lisansı',
      madeBy: 'Yapımcı',
      notAffiliated: 'Anthropic ile bağlı değildir. "Claude" ve "Claude Code", Anthropic\'in ticari markalarıdır.',
    },
    nav: {
      darkMode: 'Karanlık mod',
      lightMode: 'Aydınlık mod',
      language: 'Dil',
      menu: 'Menü',
    },
  },
};

export function t(locale: Locale): Translations {
  return translations[locale];
}
