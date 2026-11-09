/**
 * Configuração do blog "Nerd Rico" (pasta sites/nerdrico, variável SITE=nerdrico).
 * Gerada por `npm run new-site` a partir de sites/exemplo. Revise os itens marcados com TODO.
 */
import { defineSiteConfig } from "../../src/lib/config-schema.ts";

export default defineSiteConfig({
  name: "Nerd Rico",
  tagline: "Marketing digital que vende, do e-mail ao funil",
  description:
    "E-mail marketing, copywriting, funis de vendas, afiliados e produtos digitais, tráfego e ferramentas para empreendedores e infoprodutores.",
  /** Domínio com protocolo, sem barra no fim. A variável SITE_URL sobrepõe (ex.: domínio de teste). */
  url: "https://nerdrico.com.br",
  lang: "pt-BR",
  locale: "pt_BR",
  timezone: "America/Sao_Paulo",

  logo: { src: "/brand/logo.svg", width: 156, height: 40, alt: "Nerd Rico" },
  favicon: "/brand/favicon.svg",

  theme: {
    colors: {
      accent: "#6d28d9",
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
    { id: 2, slug: "email-marketing", name: "E-mail Marketing", description: "Listas, automação, segmentação e e-mails que vendem todos os dias." },
    { id: 3, slug: "copywriting", name: "Copywriting", description: "Copy, storytelling, títulos e textos de venda que convertem." },
    { id: 4, slug: "estrategias", name: "Estratégias de Venda", description: "Lançamentos, funis de vendas, landing pages e páginas de venda." },
    { id: 5, slug: "produtos-digitais", name: "Afiliados e Produtos Digitais", description: "Marketing de afiliados, PLR, licenciamento e infoprodutos." },
    { id: 6, slug: "trafego", name: "Tráfego", description: "Tráfego orgânico e pago, redes sociais e SEO para atrair clientes." },
    { id: 7, slug: "ferramentas", name: "Ferramentas", description: "Plataformas, automação e ferramentas de IA para o seu marketing." },
    { id: 8, slug: "mentalidade", name: "Mentalidade e Entrevistas", description: "Mentalidade empreendedora, entrevistas, NerdShow e Milionerd Cast." },
  ],

  authors: {
    autor: {
      // TODO: nome, função, bio e foto (public/brand/autor.webp) de quem assina os posts
      name: "Equipe Nerd Rico",
      role: "Equipe editorial",
      bio: "Equipe do Nerd Rico.", // TODO: escreva uma bio curta (ou cadastre o autor na aba Autor do painel)
      avatar: "/brand/autor.webp",
      links: {}, // TODO: { youtube: "https://www.youtube.com/@...", instagram: "..." }
    },
  },
  defaultAuthor: "autor",

  /** Usado nas páginas fixas pelos marcadores {{contact.email}} e {{legal.owner}}. */
  contact: { email: "atendimento@nerdrico.com.br" }, // o mesmo dos Termos de Uso da origem
  /** Razão social, CNPJ e cidade ainda não informados: as páginas mostram "(… a informar)". */
  legal: { owner: "Nerd Rico", city: "" },

  social: { youtube: "https://www.youtube.com/onerdrico" },

  /** As URLs de categoria deste blog ficam em /categoria/<slug>/. */
  categoryBase: "categoria",

  /** Itens do menu principal. Por padrão, as categorias. */
  /** Categoria sem artigo publicado não aparece no menu (a página dela continua existindo). */
  hideEmptyCategories: true,

  nav: [
    { label: "E-mail Marketing", href: "/categoria/email-marketing/" },
    { label: "Copywriting", href: "/categoria/copywriting/" },
    { label: "Estratégias de Venda", href: "/categoria/estrategias/" },
    { label: "Afiliados e Produtos Digitais", href: "/categoria/produtos-digitais/" },
    { label: "Tráfego", href: "/categoria/trafego/" },
    { label: "Ferramentas", href: "/categoria/ferramentas/" },
    { label: "Mentalidade e Entrevistas", href: "/categoria/mentalidade/" },
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
      href: "https://example.com/?utm_source=nerdrico",
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
        url: "https://www.youtube.com/@nerdrico",
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
      href: "https://example.com/?utm_source=nerdrico-lateral",
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
        title: "Clube Nerd Rico",
        text: "Conteúdo exclusivo para assinantes.",
        button: { label: "Conhecer o clube", href: "https://example.com/clube" },
        note: "Cancele quando quiser.",
      },
    },
    share: ["whatsapp", "facebook", "x", "linkedin", "telegram", "copy"],
    wordsPerMinute: 200,
  },

  footer: {
    text: "Nerd Rico é um blog independente. Conteúdo informativo, sem relação com as marcas citadas.",
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
    defaultImage: { src: "/brand/og-default.jpg", width: 1200, height: 630, alt: "Nerd Rico" },
    /** Logo quadrado para o JSON-LD da Organization. */
    organizationLogo: { src: "/brand/logo-512.png", width: 512, height: 512, alt: "Nerd Rico" },
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
