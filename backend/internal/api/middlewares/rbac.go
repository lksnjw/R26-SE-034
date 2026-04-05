package middlewares

import (
	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func RequirePermission(permission string, getPermissions func(*fiber.Ctx) []string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		for _, item := range getPermissions(c) {
			if item == permission {
				return c.Next()
			}
		}
		return c.Status(fiber.StatusForbidden).JSON(models.Fail("Permission denied", map[string]interface{}{"required": permission}))
	}
}
