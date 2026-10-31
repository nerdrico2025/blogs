/**
 * Modelo neutro dos blogs criados pelo assistente /admin/setup (variável SITE vazia).
 * Nome, categorias, autor, marca e cores vêm do /data/settings.json.
 */
import { defineSiteConfig } from "../../src/lib/config-schema.ts";

export default defineSiteConfig({
  name: "Novo Blog",
  tagline: "Em configuração",
  description: "Artigos e guias práticos.",
  /** Domínio com protocolo, sem barra no fim. A variável SITE_URL sobrepõe (ex.: domínio de teste). */
  url: "https://exemplo.invalid",
  lang: "pt-BR",
  locale: "pt_BR",
  timezone: "America/Sao_Paulo",

  logo: { src: "/brand/logo.svg", width: 156, height: 40, alt: "Novo Blog" },
  favicon: "/brand/favicon.svg",

  theme: {
    colors: {
      accent: "#1363df",
      accentHover: "#0e4fb3",
      heading: "#1e293b",
      text: "#334155",
      muted: "#64748b",
      bg: "#f0f5fa",
      card: "#ffffff",
      border: "#e5e9ef",
      soft: "#f7f8fa",
      ink: "#111111",
      youtube: "#e00000",
      calloutFrom: "#174c3c",
      calloutTo: "#267858",
      calloutButtonText: "#195740",
      club: "#115e59",
      imagePlaceholder: "#e6ebf1",
      cookieBg: "#04194e",
      cookieAccept: "#ffcd2a",
    },
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    layout: { container: 1140, sidebar: 280, gap: 32 },
  },

  /** O `id` é estável e nunca deve ser reaproveitado: o Wordbee guarda esse número. */
  categories: [{ id: 1, slug: "geral", name: "Geral", description: "Todos os artigos." }],

  authors: {
    autor: {
      // nome, função, bio e foto (public/brand/autor.webp) de quem assina os posts
      name: "Equipe Novo Blog",
      role: "Equipe editorial",
      bio: "Equipe do Novo Blog.",
      avatar: "/brand/autor.webp",
      links: {}, // { youtube: "https://www.youtube.com/@...", instagram: "..." }
    },
  },
  defaultAuthor: "autor",

  /** Usado nas páginas fixas pelos marcadores {{contact.email}} e {{legal.owner}}. */
  contact: { email: "contato@exemplo.invalid" }, // confirme o e-mail
  legal: { owner: "Novo Blog", city: "São Paulo, SP" },

  social: {}, // { youtube: "https://www.youtube.com/@...", instagram: "https://www.instagram.com/..." }

  /** Itens do menu principal. Por padrão, as categorias. */
  nav: [],

  ticker: {
    enabled: false,
    /**
     * "awesomeapi": cotação buscada no build (economia.awesomeapi.com.br, cache de 1 h);
     * se a API falhar, usa `value`. "static": sempre `value`.
     */
    ratesSource: "static",
    rates: [],
    clocks: [],
  },

  home: {
    perPage: 10,
    banner: {
      enabled: false, // banner da home: imagem e link do anunciante
      src: "/brand/banner-home.webp",
      width: 1200,
      height: 200,
      alt: "Espaço publicitário",
      href: "https://example.com/?utm_source=base0",
    },
  },

  sidebar: {
    order: ["search", "newsletter", "youtube", "tools", "callout", "latest", "affiliate"],
    search: { enabled: true, kicker: "Busca", title: "Encontre no blog", placeholder: "O que você procura?" },
    newsletter: {
      enabled: false, // newsletter: link de inscrição
      title: "Receba as melhores dicas",
      text: "Um e-mail por semana com as novidades do blog.",
      button: { label: "Quero receber", href: "https://example.com/newsletter" },
      note: "Gratuito. Cancele quando quiser.",
    },
    youtube: {
      enabled: false, // último vídeo: preencha channelId
      kicker: "Último vídeo",
      /** Se preenchido, o vídeo mais recente vem do RSS do canal no build (Fase 3). */
      channelId: "", // id do canal (UC...) para mostrar o último vídeo
      fallback: {
        title: "Último vídeo do canal",
        url: "https://www.youtube.com/@base0",
        thumbnail: "/brand/youtube-thumb.webp",
      },
      button: "Assistir no YouTube",
    },
    tools: {
      enabled: false,
      icon: "🧰",
      title: "Recursos",
      text: "Ferramentas que recomendamos.",
      items: [],
      button: { label: "Ver todos os recursos", href: "/sobre/" },
    },
    callout: {
      enabled: false,
      icon: "📘",
      kicker: "Guias completos",
      title: "Guias",
      text: "Materiais completos para aprofundar o assunto.",
      button: { label: "Conhecer os guias", href: "/sobre/" },
    },
    latest: { enabled: true, kicker: "Novidades", title: "Últimos artigos", count: 5, badge: "Mais recente" },
    affiliate: {
      enabled: false, // banner lateral: imagem e link do afiliado
      src: "/brand/banner-lateral.webp",
      src2x: "/brand/banner-lateral@2x.webp",
      width: 300,
      height: 600,
      alt: "Espaço publicitário",
      href: "https://example.com/?utm_source=base0-lateral",
    },
  },

  article: {
    affiliateNotice: {
      enabled: false,
      text: "Este artigo pode conter links de parceiros. Se você comprar por eles, o blog recebe uma pequena comissão, sem custo extra para você.",
    },
    toc: { enabled: true, title: "Neste artigo", minHeadings: 3 },
    /** Caixa de chamada inserida antes do H2 de número `beforeH2` (ou no meio, se houver poucos). */
    cta: {
      enabled: false, // caixa no meio do artigo: título, texto e link
      beforeH2: 3,
      label: "Saiba mais",
      title: "Conheça nossos guias",
      text: "Materiais práticos para aprofundar o assunto.",
      button: { label: "Ver os guias", href: "/sobre/" },
    },
    readMore: { enabled: true, beforeH2: 5, label: "Leia também" },
    related: { count: 3, kicker: "Continue lendo", title: "Você também pode gostar", linkLabel: "Ler artigo" },
    authorBox: {
      enabled: true,
      kicker: "Sobre o autor",
      youtubeLabel: "YouTube",
      newsletterLabel: "Newsletter",
      club: {
        enabled: false, // clube/assinatura: link
        title: "Clube Novo Blog",
        text: "Conteúdo exclusivo para assinantes.",
        button: { label: "Conhecer o clube", href: "https://example.com/clube" },
        note: "Cancele quando quiser.",
      },
    },
    share: ["whatsapp", "facebook", "x", "linkedin", "telegram", "copy"],
    wordsPerMinute: 200,
  },

  footer: {
    text: "Novo Blog é um blog independente. Conteúdo informativo; confirme preços e regras com as empresas antes de comprar.",
    links: [
      { label: "Sobre", href: "/sobre/" },
      { label: "Contato", href: "/contato/" },
      { label: "Termos de Uso", href: "/termos-de-uso/" },
      { label: "Aviso Legal", href: "/aviso-legal/" },
      { label: "Política de Privacidade", href: "/politica-de-privacidade/" },
      { label: "Política de Cookies", href: "/politica-de-cookies/" },
      { label: "Política de Afiliados", href: "/politica-de-afiliados/" },
    ],
  },

  seo: {
    /** Imagem padrão de compartilhamento (1200×630) para páginas sem capa. */
    defaultImage: { src: "/brand/og-default.jpg", width: 1200, height: 630, alt: "Novo Blog" },
    /** Logo quadrado para o JSON-LD da Organization. */
    organizationLogo: { src: "/brand/logo-512.png", width: 512, height: 512, alt: "Novo Blog" },
    twitterHandle: "",
  },

  cookies: {
    enabled: true,
    text: "Usamos cookies para medir a audiência e exibir anúncios. Você pode aceitar, rejeitar ou escolher o que permitir.",
    policyHref: "/politica-de-cookies/",
    categories: {
      analytics: { label: "Estatísticas", description: "Medem visitas e páginas mais lidas (Google Analytics), sem identificar você." },
      ads: { label: "Publicidade", description: "Permitem exibir anúncios (Google AdSense), que podem ser personalizados." },
    },
  },

  /** IDs vazios = nada é carregado. Só carregam depois do consentimento. */
  analytics: { gaId: "", adsenseClient: "" }, // IDs do Google Analytics e do AdSense
  /** Linhas do /ads.txt (ex.: "google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0"). Vazio = sem ads.txt. */
  adsTxt: [],
});
