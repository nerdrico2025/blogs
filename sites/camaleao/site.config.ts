/**
 * Blog "camaleão" (pasta sites/camaleao, variável SITE=camaleao): o mesmo serviço reaproveitado
 * para um domínio por vez. Tudo o que muda a cada rodada (marca, assunto, textos, categorias,
 * páginas, domínio, anúncios) é preenchido no /admin e fica no volume; este arquivo guarda só
 * o ponto de partida neutro, para onde o blog volta em "Domínio > Reiniciar para novo domínio".
 * Gerado por `npm run new-site` a partir de sites/exemplo (mesmo layout do asasdomundo).
 */
import { defineSiteConfig } from "../../src/lib/config-schema.ts";

export default defineSiteConfig({
  name: "Novo Blog",
  tagline: "Artigos e guias práticos",
  description: "Novo Blog: artigos e guias práticos, escritos com cuidado e atualizados com frequência.", // TODO: descreva o assunto do blog
  /** Domínio com protocolo, sem barra no fim. A variável SITE_URL sobrepõe (ex.: domínio de teste). */
  url: "https://camaleao.example.com",
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
      imagePlaceholder: "#e6ebf1",
      cookieBg: "#04194e",
    },
    fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    layout: { container: 1140, sidebar: 280, gap: 32 },
  },

  /** O `id` é estável e nunca deve ser reaproveitado: o Wordbee guarda esse número. */
  categories: [
    { id: 2, slug: "geral", name: "Geral", description: "Todos os artigos." },
  ],

  authors: {
    autor: {
      // TODO: nome, função, bio e foto (public/brand/autor.webp) de quem assina os posts
      name: "Equipe Novo Blog",
      role: "Equipe editorial",
      bio: "Equipe do Novo Blog.",
      avatar: "/brand/autor.webp",
      links: {}, // TODO: { youtube: "https://www.youtube.com/@...", instagram: "..." }
    },
  },
  defaultAuthor: "autor",

  /** Usado nas páginas fixas pelos marcadores {{contact.email}} e {{legal.owner}}. */
  contact: { email: "contato@camaleao.example.com" }, // TODO: confirme o e-mail
  legal: { owner: "Novo Blog", city: "São Paulo, SP" },

  social: {}, // TODO: { youtube: "https://www.youtube.com/@...", instagram: "https://www.instagram.com/..." }

  /** Itens do menu principal. Por padrão, as categorias. */
  nav: [
    { label: "Geral", href: "/category/geral/" },
  ],

  ticker: {
    enabled: false,
    /**
     * "awesomeapi": cotação buscada no build (economia.awesomeapi.com.br, cache de 1 h);
     * se a API falhar, usa `value`. "static": sempre `value`.
     */
    ratesSource: "awesomeapi",
    rates: [
      { label: "Dólar", code: "USD", value: "R$ 5,42" },
      { label: "Euro", code: "EUR", value: "R$ 6,11" },
    ],
    clocks: [{ label: "Brasília", timezone: "America/Sao_Paulo" }],
  },

  home: {
    perPage: 10,
    banner: {
      enabled: false, // TODO: banner da home: imagem e link do anunciante
      src: "/brand/banner-home.webp",
      width: 1200,
      height: 200,
      alt: "Espaço publicitário",
      href: "https://example.com/?utm_source=camaleao",
    },
  },

  sidebar: {
    order: ["search", "newsletter", "youtube", "tools", "callout", "latest", "affiliate"],
    search: { enabled: true, kicker: "Busca", title: "Encontre no blog", placeholder: "O que você procura?" },
    newsletter: {
      enabled: false, // TODO: newsletter: link de inscrição
      title: "Receba as melhores dicas",
      text: "Um e-mail por semana com os artigos novos.",
      button: { label: "Quero receber", href: "https://example.com/newsletter" },
      note: "Gratuito. Cancele quando quiser.",
    },
    youtube: {
      enabled: false, // TODO: último vídeo: preencha channelId
      kicker: "Último vídeo",
      /** Se preenchido, o vídeo mais recente vem do RSS do canal no build (Fase 3). */
      channelId: "", // TODO: id do canal (UC...) para mostrar o último vídeo
      fallback: {
        title: "Último vídeo do canal",
        url: "https://www.youtube.com/@camaleao",
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
      enabled: false, // TODO: banner lateral: imagem e link do afiliado
      src: "/brand/banner-lateral.webp",
      src2x: "/brand/banner-lateral@2x.webp",
      width: 300,
      height: 600,
      alt: "Espaço publicitário",
      href: "https://example.com/?utm_source=camaleao-lateral",
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
      enabled: false, // TODO: caixa no meio do artigo: título, texto e link
      beforeH2: 3,
      label: "Vale a leitura",
      title: "Conheça o nosso guia",
      text: "Um material completo para aprofundar o assunto.",
      button: { label: "Ver o guia", href: "/sobre/" },
    },
    readMore: { enabled: true, beforeH2: 5, label: "Leia também" },
    related: { count: 3, kicker: "Continue lendo", title: "Você também pode gostar", linkLabel: "Ler artigo" },
    authorBox: {
      enabled: false, // TODO: caixa do autor: aparece ao cadastrar na aba Autor do painel
      kicker: "Quem escreve",
      youtubeLabel: "YouTube",
      newsletterLabel: "Newsletter",
      club: {
        enabled: false, // TODO: clube/assinatura: link
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
    text: "Novo Blog é um blog independente. Conteúdo informativo, sem relação com as marcas citadas.",
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
  analytics: { gaId: "", adsenseClient: "" }, // TODO: IDs do Google Analytics e do AdSense
  /** Linhas do /ads.txt (ex.: "google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0"). Vazio = sem ads.txt. */
  adsTxt: [],
});
