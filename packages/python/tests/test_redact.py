import pytest
from port.helpers.redact import (
    REDACT_EMAIL,
    REDACT_PHONE,
    REDACT_POSTAL_CODE,
    redact,
    redact_dutch_postal_code,
    redact_email,
    redact_phone,
)


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

class TestRedactEmail:
    def test_simple_email(self):
        assert redact_email("Contact me at user@example.com please.") == \
            f"Contact me at {REDACT_EMAIL} please."

    def test_email_with_plus(self):
        assert redact_email("user+tag@sub.domain.org") == REDACT_EMAIL

    def test_multiple_emails(self):
        result = redact_email("a@b.com and c@d.nl")
        assert result == f"{REDACT_EMAIL} and {REDACT_EMAIL}"

    def test_crazy_email(self):
        result = redact_email("jkh24387edfjhsfdjha@hsjkdhjsdb.sdhdsikjhsd")
        assert result == f"{REDACT_EMAIL}"

    def test_no_email(self):
        text = "No email here."
        assert redact_email(text) == text

    def test_email_uppercase(self):
        assert redact_email("USER@EXAMPLE.COM") == REDACT_EMAIL


# ---------------------------------------------------------------------------
# Dutch postal codes
# ---------------------------------------------------------------------------

class TestRedactDutchPostalCode:
    def test_without_space(self):
        assert redact_dutch_postal_code("1234AB") == REDACT_POSTAL_CODE

    def test_with_space(self):
        assert redact_dutch_postal_code("1234 AB") == REDACT_POSTAL_CODE

    def test_lowercase_letters(self):
        assert redact_dutch_postal_code("2500 gc") == REDACT_POSTAL_CODE

    def test_mixed_case(self):
        assert redact_dutch_postal_code("3512Xz") == REDACT_POSTAL_CODE

    def test_in_sentence(self):
        result = redact_dutch_postal_code("Mijn adres is 2500GC Den Haag.")
        assert result == f"Mijn adres is {REDACT_POSTAL_CODE} Den Haag."

    def test_multiple_postal_codes(self):
        result = redact_dutch_postal_code("Van 1011AB naar 3571ZX")
        assert result == f"Van {REDACT_POSTAL_CODE} naar {REDACT_POSTAL_CODE}"

    def test_no_postal_code(self):
        text = "Geen postcode hier."
        assert redact_dutch_postal_code(text) == text

    def test_invalid_leading_zero_not_redacted(self):
        # Dutch postal codes never start with 0
        assert redact_dutch_postal_code("0123AB") == "0123AB"


# ---------------------------------------------------------------------------
# Phone numbers
# ---------------------------------------------------------------------------

class TestRedactPhone:
    # --- Valid phone numbers (should be redacted) ---
    # to not let the regex get too out of hand some choices have to be made
    # check the tests below to see what the regex coovers

    def test_dutch_mobile(self):
        assert redact_phone("06-12345678") == REDACT_PHONE

    def test_dutch_international(self):
        assert redact_phone("+31 6 12345678") == REDACT_PHONE

    def test_dutch_local_with_parens(self):
        assert redact_phone("(020) 1234567") == REDACT_PHONE

    def test_plain_digits(self):
        assert redact_phone("0201234567") == REDACT_PHONE

    def test_with_spaces(self):
        assert redact_phone("06 1234 5678") == "06 1234 5678"

    def test_with_dots(self):
        assert redact_phone("06.1234.5678") == "06.1234.5678"

    def test_mixed_format(self):
        assert redact_phone("+31 (0)6-1234 5678") == "+31 (0)6-1234 5678"

    def test_embedded_in_text(self):
        text = "Call me at 06-12345678 tomorrow"
        assert redact_phone(text) == f"Call me at {REDACT_PHONE} tomorrow"

    def test_multiple_numbers(self):
        text = "Home: 0201234567, Mobile: 06-12345678"
        expected = f"Home: {REDACT_PHONE}, Mobile: {REDACT_PHONE}"
        assert redact_phone(text) == expected


    # --- Non-phone numbers (should NOT be redacted) ---

    def test_no_phone(self):
        text = "No phone number here."
        assert redact_phone(text) == text

    def test_year(self):
        text = "The year is 2024."
        assert redact_phone(text) == text

    def test_short_number(self):
        text = "My code is 1234."
        assert redact_phone(text) == text

    def test_long_random_number(self):
        text = "Order ID: 123456789012345"
        assert redact_phone(text) == text

    def test_decimal_number(self):
        text = "The value is 12345.6789"
        assert redact_phone(text) == text

    def test_date_format(self):
        text = "Date: 2024-01-01"
        assert redact_phone(text) == text

    def test_time_format(self):
        text = "Meeting at 12:30"
        assert redact_phone(text) == text

    def test_zip_code(self):
        text = "My zip code is 1234 AB"
        assert redact_phone(text) == text

    def test_mixed_numbers_and_text(self):
        text = "Product 123456 is in stock"
        assert redact_phone(text) == text

    def test_ipv4_address(self):
        text = "Server IP is 192.168.1.1"
        assert redact_phone(text) == text
    # --- Edge cases ---

    def test_too_short_to_be_phone(self):
        assert redact_phone("06123") == "06123"

    def test_too_long_to_be_phone(self):
        assert redact_phone("061234567890123") == "061234567890123"

    def test_number_with_letters(self):
        text = "Call me at 06-1234ABCD"
        assert redact_phone(text) == text

    def test_partial_phone_like_pattern(self):
        text = "Number: 020-123"
        assert redact_phone(text) == text

    def test_plus_without_valid_number(self):
        text = "+999 is not a phone number"
        assert redact_phone(text) == text

# ---------------------------------------------------------------------------
# Combined redact()
# ---------------------------------------------------------------------------

class TestRedact:
    def test_redacts_all_types(self):
        text = "Email me at jan@example.nl, call +31 6 12345678, zip 1234 AB."
        result = redact(text)
        assert REDACT_EMAIL in result
        assert REDACT_PHONE in result
        assert REDACT_POSTAL_CODE in result
        assert "jan@example.nl" not in result
        assert "1234 AB" not in result

    def test_plain_text_unchanged(self):
        text = "This sentence has nothing sensitive."
        assert redact(text) == text

    def test_empty_string(self):
        assert redact("") == ""
