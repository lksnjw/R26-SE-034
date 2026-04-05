package handlers

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) Login(c *fiber.Ctx) error {
	var req models.LoginRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()

	var user *models.User
	for _, candidate := range h.Store.Users {
		if strings.EqualFold(candidate.Email, req.Email) {
			user = candidate
			break
		}
	}
	if user == nil {
		user = h.Store.Users["usr_001"]
	}
	now := time.Now().UTC()
	user.LastLoginAt = &now

	tokens, err := h.tokenForUser(user.ID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not sign access token")
	}

	session := models.AuthSession{
		AccessToken:  tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresIn:    tokens.ExpiresIn,
		User: map[string]interface{}{
			"id":               user.ID,
			"name":             user.Name,
			"email":            user.Email,
			"role":             user.Role.Name,
			"permissions":      user.Permissions,
			"twoFactorEnabled": user.TwoFactorEnabled,
			"emailVerified":    user.EmailVerified,
		},
	}

	return c.JSON(models.OK(session, "Login successful", nil))
}

func (h *Handler) Register(c *fiber.Ctx) error {
	var req models.RegisterRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()

	role := h.Store.Roles["role_builder"]
	id := h.Store.NextID("usr")
	user := &models.User{
		ID: id, Name: req.Name, Email: req.Email, Role: models.RoleRef{ID: role.ID, Name: role.Name},
		Permissions: role.Permissions, Status: "Active", Initials: initials(req.Name), CreatedAt: time.Now().UTC(), EmailVerified: true,
	}
	h.Store.Users[id] = user

	tokens, err := h.tokenForUser(id)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not sign access token")
	}

	return c.Status(fiber.StatusCreated).JSON(models.OK(models.AuthSession{AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, ExpiresIn: tokens.ExpiresIn, User: user}, "Registration successful", nil))
}

func (h *Handler) Logout(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]bool{"loggedOut": true}, "Logged out", nil))
}

func (h *Handler) Refresh(c *fiber.Ctx) error {
	token, err := h.tokenForUser("usr_001")
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not refresh token")
	}
	return c.JSON(models.OK(token, "Token refreshed", nil))
}

func (h *Handler) Me(c *fiber.Ctx) error {
	return c.JSON(models.OK(h.currentUser(c), "OK", nil))
}

func (h *Handler) ForgotPassword(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]bool{"sent": true}, "Password reset instructions sent", nil))
}

func (h *Handler) ResetPassword(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]bool{"reset": true}, "Password reset", nil))
}

func (h *Handler) VerifyEmail(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]bool{"verified": true}, "Email verified", nil))
}

func (h *Handler) TwoFactorVerify(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]bool{"verified": true}, "Two-factor code verified", nil))
}

func (h *Handler) TwoFactorEnable(c *fiber.Ctx) error {
	user := h.currentUser(c)
	h.Store.Mu.Lock()
	user.TwoFactorEnabled = true
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"enabled": true}, "Two-factor authentication enabled", nil))
}

func (h *Handler) TwoFactorDisable(c *fiber.Ctx) error {
	user := h.currentUser(c)
	h.Store.Mu.Lock()
	user.TwoFactorEnabled = false
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"enabled": false}, "Two-factor authentication disabled", nil))
}

func (h *Handler) OAuthAuthorize(c *fiber.Ctx) error {
	provider := c.Params("provider")
	return c.JSON(models.OK(map[string]string{"provider": provider, "redirectUrl": h.Cfg.FrontendURL + "/auth/callback?provider=" + provider + "&code=local-dev"}, "OAuth authorization URL created", nil))
}

func (h *Handler) OAuthCallback(c *fiber.Ctx) error {
	tokens, err := h.tokenForUser("usr_001")
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Could not sign access token")
	}
	return c.JSON(models.OK(models.AuthSession{AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, ExpiresIn: tokens.ExpiresIn, User: h.Store.Users["usr_001"]}, "OAuth login successful", nil))
}
