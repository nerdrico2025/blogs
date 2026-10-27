/**
 * Configuração do blog de exemplo ("Rota Leve", fictício). Também é o modelo
 * usado por `npm run new-site`. Cada blog tem a sua pasta em sites/<nome>/:
 * este arquivo, public/brand/ (logo, banners, imagens) e pages/ (páginas fixas).
 * Nenhum componente tem marca, cor ou texto de marca fixo no código.
 */
import { defineSiteConfig } from "../../src/lib/config-schema.ts";

export default defineSiteConfig({
  name: "Rota Leve",
  tagline: "Viagens bem planejadas, sem complicação",
  description:
    "Roteiros, dicas práticas e guias para viajar melhor gastando menos. Planejamento, passagens, hospedagem e dinheiro no exterior.",
  /** Domínio com protocolo, sem barra no fim. A variável SITE_URL sobrepõe (ex.: domínio de teste). */
  url: "https://rotaleve.example",
  lang: "pt-BR",
  locale: "pt_BR",
  timezone: "America/Sao_Paulo",

  logo: { src: "/brand/logo.svg", width: 168, height: 40, alt: "Rota Leve" },
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
  categories: [
    { id: 2, slug: "roteiros", name: "Roteiros", description: "Roteiros dia a dia para cidades e regiões, com o que ver, onde comer e como se locomover." },
    { id: 3, slug: "dicas", name: "Dicas", description: "Dicas práticas para viajar com mais conforto, segurança e economia." },
    { id: 4, slug: "dinheiro", name: "Dinheiro e câmbio", description: "Cartões, câmbio, IOF e como levar dinheiro para o exterior." },
    { id: 5, slug: "hospedagem", name: "Hospedagem", description: "Como escolher hotel, hostel ou apartamento e reservar pelo melhor preço." },
    { id: 6, slug: "voos", name: "Voos", description: "Passagens aéreas, milhas, bagagem e direitos do passageiro." },
    { id: 7, slug: "planejamento", name: "Planejamento", description: "Checklists, documentos e prazos para planejar a viagem sem esquecer nada." },
  ],

  authors: {
    "clara-menezes": {
      name: "Clara Menezes",
      role: "Editora e viajante",
      bio: "Planeja viagens há mais de dez anos e já organizou roteiros por quatro continentes. Escreve guias práticos para quem quer viajar bem sem gastar demais.",
      avatar: "/brand/autora.webp",
      links: { youtube: "https://www.youtube.com/@rotaleve-exemplo", instagram: "https://www.instagram.com/rotaleve-exemplo" },
    },
  },
  defaultAuthor: "clara-menezes",

  /** Usado nas páginas fixas pelos marcadores {{contact.email}} e {{legal.owner}}. */
  contact: { email: "contato@rotaleve.example" },
  legal: { owner: "Rota Leve", city: "São Paulo, SP" },

  social: {
    youtube: "https://www.youtube.com/@rotaleve-exemplo",
    instagram: "https://www.instagram.com/rotaleve-exemplo",
  },

  /** Itens do menu principal. Por padrão, as categorias. */
  nav: [
    { label: "Roteiros", href: "/category/roteiros/" },
    { label: "Dicas", href: "/category/dicas/" },
    { label: "Dinheiro", href: "/category/dinheiro/" },
    { label: "Hospedagem", href: "/category/hospedagem/" },
    { label: "Voos", href: "/category/voos/" },
    { label: "Planejamento", href: "/category/planejamento/" },
  ],

  ticker: {
    enabled: true,
    /**
     * "awesomeapi": cotação buscada no build (economia.awesomeapi.com.br, cache de 1 h);
     * se a API falhar, usa `value`. "static": sempre `value`.
     */
    ratesSource: "awesomeapi",
    rates: [
      { label: "Dólar", code: "USD", value: "R$ 5,42" },
      { label: "Euro", code: "EUR", value: "R$ 6,11" },
    ],
    clocks: [
      { label: "São Paulo", timezone: "America/Sao_Paulo" },
      { label: "Lisboa", timezone: "Europe/Lisbon" },
      { label: "Nova York", timezone: "America/New_York" },
      { label: "Paris", timezone: "Europe/Paris" },
      { label: "Tóquio", timezone: "Asia/Tokyo" },
    ],
  },

  home: {
    perPage: 10,
    banner: {
      enabled: true,
      src: "/brand/banner-home.webp",
      width: 1200,
      height: 200,
      alt: "Espaço publicitário de exemplo: seguro viagem",
      href: "https://example.com/?utm_source=rotaleve",
    },
  },

  sidebar: {
    order: ["search", "newsletter", "youtube", "tools", "callout", "latest", "affiliate"],
    search: { enabled: true, kicker: "Busca", title: "Encontre no blog", placeholder: "Ex.: Lisboa, mala de mão…" },
    newsletter: {
      enabled: true,
      title: "Receba as melhores dicas",
      text: "Um e-mail por semana com roteiros, promoções de passagens e dicas para economizar.",
      button: { label: "Quero receber", href: "https://example.com/newsletter" },
      note: "Gratuito. Cancele quando quiser.",
    },
    youtube: {
      enabled: true,
      kicker: "Último vídeo",
      /** Se preenchido, o vídeo mais recente vem do RSS do canal no build (Fase 3). */
      channelId: "",
      fallback: {
        title: "Como montar um roteiro de viagem em 30 minutos",
        url: "https://www.youtube.com/@rotaleve-exemplo",
        thumbnail: "/brand/youtube-thumb.webp",
      },
      button: "Assistir no YouTube",
    },
    tools: {
      enabled: true,
      icon: "🧳",
      title: "Vai viajar?",
      text: "Ferramentas que usamos para planejar cada viagem.",
      items: [
        { icon: "🏨", label: "Hotéis e apartamentos" },
        { icon: "✈️", label: "Passagens aéreas" },
        { icon: "🛡️", label: "Seguro viagem" },
        { icon: "📶", label: "Chip internacional" },
        { icon: "🚗", label: "Aluguel de carro" },
      ],
      button: { label: "Ver todos os recursos", href: "/sobre/" },
    },
    callout: {
      enabled: true,
      icon: "🗺️",
      kicker: "Guias completos",
      title: "Guias de Viagem",
      text: "Roteiros prontos, mapas e listas de checagem para baixar e levar no celular.",
      button: { label: "Conhecer os guias", href: "/category/roteiros/" },
    },
    latest: { enabled: true, kicker: "Novidades", title: "Últimos artigos", count: 5, badge: "Mais recente" },
    affiliate: {
      enabled: true,
      src: "/brand/banner-lateral.webp",
      src2x: "/brand/banner-lateral@2x.webp",
      width: 300,
      height: 600,
      alt: "Espaço publicitário de exemplo: chip internacional",
      href: "https://example.com/?utm_source=rotaleve-lateral",
    },
  },

  article: {
    affiliateNotice: {
      enabled: true,
      text: "Este artigo pode conter links de parceiros. Se você comprar por eles, o blog recebe uma pequena comissão, sem custo extra para você.",
    },
    toc: { enabled: true, title: "Neste artigo", minHeadings: 3 },
    /** Caixa de chamada inserida antes do H2 de número `beforeH2` (ou no meio, se houver poucos). */
    cta: {
      enabled: true,
      beforeH2: 3,
      label: "Planeje com calma",
      title: "Monte seu roteiro com o nosso checklist",
      text: "Uma lista com tudo o que precisa ser resolvido antes de embarcar, do passaporte ao seguro.",
      button: { label: "Ver o checklist", href: "/checklist-viagem-internacional/" },
    },
    readMore: { enabled: true, beforeH2: 5, label: "Leia também" },
    related: { count: 3, kicker: "Continue lendo", title: "Você também pode gostar", linkLabel: "Ler artigo" },
    authorBox: {
      enabled: true,
      kicker: "Sobre a autora",
      youtubeLabel: "YouTube",
      newsletterLabel: "Newsletter",
      club: {
        enabled: true,
        title: "Clube Rota Leve",
        text: "Alertas de promoções de passagens e roteiros exclusivos para assinantes.",
        button: { label: "Conhecer o clube", href: "https://example.com/clube" },
        note: "Cancele quando quiser.",
      },
    },
    share: ["whatsapp", "facebook", "x", "linkedin", "telegram", "copy"],
    wordsPerMinute: 200,
  },

  footer: {
    text: "Rota Leve é um blog independente de viagem. Conteúdo informativo; confirme preços e regras com as empresas antes de comprar.",
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
    defaultImage: { src: "/brand/og-default.jpg", width: 1200, height: 630, alt: "Rota Leve: viagens bem planejadas" },
    /** Logo quadrado para o JSON-LD da Organization. */
    organizationLogo: { src: "/brand/logo-512.png", width: 512, height: 512, alt: "Rota Leve" },
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
  analytics: { gaId: "", adsenseClient: "" },
  /** Linhas do /ads.txt (ex.: "google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0"). Vazio = sem ads.txt. */
  adsTxt: [],
});
