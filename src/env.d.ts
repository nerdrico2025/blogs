declare namespace App {
  interface Locals {
    /** Tipo de página para as posições de anúncio; sem valor, a página não tem anúncios. */
    ad?: import("./lib/ads.ts").AdContext;
  }
}
