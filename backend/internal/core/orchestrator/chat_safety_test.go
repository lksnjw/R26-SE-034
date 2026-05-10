package orchestrator

import "testing"

func TestDestructiveIdentityRequestErrors(t *testing.T) {
	blockedPrompts := []string{
		"delete the admin",
		"remove employee",
		"disable user account",
		"revoke admin access",
		"terminate employees",
	}
	for _, prompt := range blockedPrompts {
		blocked, errors := destructiveIdentityRequestErrors(prompt)
		if !blocked {
			t.Fatalf("expected %q to be blocked", prompt)
		}
		if len(errors) == 0 {
			t.Fatalf("expected blocking errors for %q", prompt)
		}
	}

	allowedPrompts := []string{
		"create purchase order for 150 laptops",
		"list invoices for finance review",
		"delete purchase order draft PO-123",
	}
	for _, prompt := range allowedPrompts {
		blocked, _ := destructiveIdentityRequestErrors(prompt)
		if blocked {
			t.Fatalf("expected %q to pass the identity safety precheck", prompt)
		}
	}
}
