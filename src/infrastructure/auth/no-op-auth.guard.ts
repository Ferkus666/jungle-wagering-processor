import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão de autenticação.
 *
 * O desafio não exige autenticação (ver ARCHITECTURE.md, seção 1), mas pede que a
 * decisão de não implementá-la deixe um ponto de extensão explícito no código.
 *
 * Esta implementação é intencionalmente um no-op: permite todas as requisições.
 * Para integrar um Identity Provider real (Keycloak, Zitadel ou equivalente), troque
 * esta classe por um guard que valide o token OIDC/JWT do provider e exponha a
 * identidade resolvida no request, mantendo a mesma interface `CanActivate` — nenhum
 * controller precisaria mudar.
 */
@Injectable()
export class NoOpAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
